import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, NO_ANSWER } from "../../apps/node/src/actions.js";
import type { App } from "../../apps/node/src/app.js";
import { connectAgents } from "../../apps/node/src/connect.js";
import { APPROVAL_TOOL } from "../../apps/node/src/tools/approval.js";
import { now } from "../../apps/node/src/util.js";
import { tempDir, testApp } from "./helpers.js";

let apps: App[] = [];
const env = { ...process.env };
afterEach(async () => {
  process.env = { ...env };
  for (const app of apps) {
    await app.runner.idle();
    await app.plugins.stop();
    app.db.close();
  }
  apps = [];
});

/** Fake claude and codex on PATH; claude writes the arguments it got. */
function fakeAgents(): { dir: string; calls: string } {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "claude-calls");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> ${calls}\n`);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  process.env.CODEX_HOME = join(dir, "codex");
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n');
  return { dir, calls };
}

describe("connecting coding agents", () => {
  it("adds Vireo to Claude Code and Codex over MCP with keys, and again without duplicates", () => {
    const { dir, calls } = fakeAgents();
    const data = tempDir();
    for (let i = 0; i < 2; i++) expect(connectAgents({ dataDir: data, port: 8787 })).toHaveLength(2);

    expect(readFileSync(calls, "utf8")).toMatch(/mcp add --scope user --transport http vireo http:\/\/127\.0\.0\.1:8787\/public\/mcp --header Authorization: Bearer vireo_/);
    // The owner's own sessions get no hooks and no notify.
    expect(existsSync(join(dir, "claude", "settings.json"))).toBe(false);
    const toml = readFileSync(join(dir, "codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.vireo\]/g)).toHaveLength(1);
    expect(toml).not.toMatch(/^notify/m);
    expect(toml).toContain('[profiles.fast]\nmodel = "gpt-5-mini"');
    expect(toml).toMatch(/http_headers = \{ "Authorization" = "Bearer vireo_/);

    // One key per agent, replaced rather than piled up; the plugin is added.
    const app = testApp(data);
    apps.push(app);
    expect((app.db.getKv<{ name: string }[]>("plugin.endpoint.keys") ?? []).map((k) => k.name).sort()).toEqual([expect.stringMatching(/^Claude Code on /), expect.stringMatching(/^Codex on /)]);
    expect(app.plugins.installed("endpoint")).toBe(true);
  });

  it("takes out the hooks and notify earlier versions added, and leaves the owner's own", () => {
    const { dir } = fakeAgents();
    const data = tempDir();
    const ours = (timeout: number, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: '"/usr/bin/node" "/opt/vireo/cli.js" hook claude', timeout }] });
    const theirs = { hooks: [{ type: "command", command: "bash ~/my-hook.sh" }] };
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { Stop: [theirs, ours(30)], Notification: [ours(30)], PreToolUse: [ours(600, "Bash")] } }));
    writeFileSync(join(dir, "codex", "config.toml"), 'notify = ["/usr/bin/node","/opt/vireo/cli.js","hook","codex"]\nmodel = "gpt-5"\n');
    writeFileSync(join(data, "hooks.json"), "{}");

    connectAgents({ dataDir: data, port: 8787 });

    expect(JSON.parse(readFileSync(join(dir, "claude", "settings.json"), "utf8"))).toEqual({ model: "opus", hooks: { Stop: [theirs] } });
    const toml = readFileSync(join(dir, "codex", "config.toml"), "utf8");
    expect(toml).not.toMatch(/^notify/m);
    expect(toml.startsWith('model = "gpt-5"')).toBe(true);
    expect(existsSync(join(data, "hooks.json"))).toBe(false);

    // A notify of the owner's own stays.
    writeFileSync(join(dir, "codex", "config.toml"), 'notify = ["my-notify"]\n');
    connectAgents({ dataDir: data, port: 8787, only: ["codex"] });
    expect(readFileSync(join(dir, "codex", "config.toml"), "utf8").startsWith('notify = ["my-notify"]')).toBe(true);
  });

  it("lets an approval nobody answered lapse after half an hour, and no longer wait on the owner", () => {
    const app = testApp();
    apps.push(app);
    const ask = (title: string) => {
      const thread = app.threads.create({ title, temporary: true });
      return app.actions.create(thread.id, APPROVAL_TOOL, { from: "Claude Code" }, title);
    };
    const old = ask("Run: rm -rf dist");
    const fresh = ask("Run: rm -rf build");
    app.db.run("UPDATE actions SET created_at = ? WHERE id = ?", now() - APPROVAL_TTL_MS - 1000, old.id);
    expect(app.threads.get(old.threadId)!.needsYou).toBe(true);

    expect(app.actions.expireApprovals()).toBe(1);
    expect(app.actions.get(old.id)).toMatchObject({ status: "cancelled", result: NO_ANSWER });
    expect(app.threads.get(old.threadId)).toMatchObject({ needsYou: false, pendingActions: 0 });
    // A younger one keeps waiting, and the owner can still decide it.
    expect(app.actions.get(fresh.id)!.status).toBe("pending");
    expect(app.threads.get(fresh.threadId)!.needsYou).toBe(true);
    // Only agents' approvals lapse: Vireo's own confirmations wait for the owner.
    const own = app.actions.create(app.threads.create({ title: "Send the email" }).id, "send_email", {}, "Send the email");
    app.db.run("UPDATE actions SET created_at = ? WHERE id = ?", now() - APPROVAL_TTL_MS - 1000, own.id);
    expect(app.actions.expireApprovals()).toBe(0);
    expect(app.actions.get(own.id)!.status).toBe("pending");
  });
});
