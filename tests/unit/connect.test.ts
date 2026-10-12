import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { connectAgents } from "../../apps/node/src/connect.js";
import { risky } from "../../apps/node/src/hook.js";
import { createHttp } from "../../apps/node/src/http/index.js";
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
  it("adds Vireo to Claude Code and Codex with keys and hooks, and again without duplicates", () => {
    const { dir, calls } = fakeAgents();
    const data = tempDir();
    for (let i = 0; i < 2; i++) expect(connectAgents({ dataDir: data, port: 8787, cli: "/opt/vireo/cli.js" })).toHaveLength(2);

    expect(readFileSync(calls, "utf8")).toMatch(/mcp add --scope user --transport http vireo http:\/\/127\.0\.0\.1:8787\/public\/mcp --header Authorization: Bearer vireo_/);
    const settings = JSON.parse(readFileSync(join(dir, "claude", "settings.json"), "utf8"));
    for (const event of ["Stop", "Notification", "PreToolUse"]) expect(settings.hooks[event]).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash", hooks: [{ timeout: 600 }] });
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('"/opt/vireo/cli.js" hook claude');

    const toml = readFileSync(join(dir, "codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.vireo\]/g)).toHaveLength(1);
    expect(toml.startsWith("notify = [")).toBe(true);
    expect(toml).toContain('[profiles.fast]\nmodel = "gpt-5-mini"');
    expect(toml).toMatch(/http_headers = \{ "Authorization" = "Bearer vireo_/);

    // One key per agent and one for the hooks, replaced rather than piled up; the plugin is added.
    const app = testApp(data);
    apps.push(app);
    expect((app.db.getKv<{ name: string }[]>("plugin.endpoint.keys") ?? []).map((k) => k.name).sort()).toEqual([expect.stringMatching(/^Claude Code on /), expect.stringMatching(/^Codex on /), expect.stringMatching(/^Hooks on /)]);
    expect(app.plugins.installed("endpoint")).toBe(true);
  });

  it("asks only about risky shell commands", () => {
    for (const c of ["rm -rf build", "git push --force origin main", "kubectl delete pod x", "terraform apply", "npm publish", "psql -c 'DROP TABLE users'", "wrangler deploy"]) expect(risky(c)).toBe(true);
    for (const c of ["ls -la", "npm test", "git push origin feature", "rm file.txt", "git status", "kubectl get pods"]) expect(risky(c)).toBe(false);
  });

  it("holds a risky command until the owner decides in Vireo", async () => {
    fakeAgents();
    const { serve } = await import("@hono/node-server");
    const data = tempDir();
    const app = testApp(data);
    apps.push(app);
    const server = serve({ fetch: createHttp(app).fetch, port: 0, hostname: "127.0.0.1" });
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    try {
      connectAgents({ dataDir: data, port: (server.address() as { port: number }).port, cli: "x", only: ["claude"] });
      const hook = (input: object) =>
        new Promise<string>((done) => {
          const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/node/src/cli.ts"), "hook", "claude"], { env: { ...process.env, VIREO_DATA_DIR: data } });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("close", () => done(out));
          child.stdin.end(JSON.stringify(input));
        });
      const pending = () => app.actions.pending().find((a) => a.summary.includes("rm -rf"));

      const asked = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf dist" }, cwd: "/work/site" });
      for (let i = 0; i < 200 && !pending(); i++) await new Promise((r) => setTimeout(r, 50));
      await app.actions.confirm(pending()!.id);
      expect(JSON.parse(await asked)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });

      expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toBe("");
      await hook({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash", cwd: "/work/site" });
      expect(app.push.recent[0]).toMatchObject({ title: expect.stringContaining("Claude Code needs you · Claude Code in site"), body: expect.stringContaining("permission") });
    } finally {
      server.close();
    }
  }, 60_000);
});
