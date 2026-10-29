import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { App } from "../../apps/node/src/app.js";
import { AcpAgents, agentEnv, agentOverlay, insideWorkdir, permissionFor, requestPaths, TurnReader, type AgentSpec } from "../../apps/node/src/acp.js";
import { detectedSetups, readProfile } from "../../apps/node/src/plugins/agents/index.js";
import type { ToolContext } from "../../apps/node/src/tools/types.js";
import { tempDir, testApp } from "./helpers.js";

/**
 * Coding agents, built into Vireo: its tools and specialist are always there,
 * it starts from the agents found on this machine, holds several setups at once, and it refuses to run until a setup
 * names a directory that exists. The agents themselves are separate programs,
 * so nothing here starts one.
 */

let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.plugins.stop();
    try {
      app.db.close();
    } catch {
      // already closed
    }
  }
  apps = [];
});

function open(): App {
  const app = testApp();
  apps.push(app);
  return app;
}

const view = async (app: App) => (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "agents")!;

describe("coding agents plugin", () => {
  it("is built in: its tools and specialist are there from the start, and it can't be removed", async () => {
    const app = open();
    expect(app.tools.has("coding_agent_run")).toBe(true);
    expect(app.plugins.agents().map((a) => a.name)).toContain("coder");
    expect(await view(app)).toMatchObject({ installed: true, builtin: true });
    expect(app.plugins.capabilities().find((c) => c.id === "agents")).toMatchObject({ builtin: true });

    await app.plugins.configure("agents", { agents: [{ name: "work", command: "claude", directory: tempDir() }] });
    expect((await view(app)).status).toMatchObject({ state: "ready" });

    await expect(app.plugins.uninstall("agents")).rejects.toThrow(/part of Vireo/);
    expect(app.tools.has("coding_agent_run")).toBe(true);
  });

  it("holds several setups, each with its own agent and repository", async () => {
    const app = open();
    const one = tempDir();
    const two = tempDir();
    await app.plugins.install("agents", {
      agents: [
        { name: "work", command: "claude", directory: one, mode: "edits" },
        { name: "hobby", command: "opencode", directory: two, mode: "read-only" },
      ],
    });
    const status = (await view(app)).status!;
    expect(status).toMatchObject({ state: "ready" });
    expect(status.details?.map((d) => d.label)).toEqual(["work", "hobby"]);
    expect(status.details?.[1]?.value).toContain("opencode");
  });

  it("starts from the agents found on this machine, in the home directory", async () => {
    const app = open();
    const found = detectedSetups();
    const rows = (await view(app)).config.agents as { command: string; directory: string }[];
    expect(rows.map((r) => r.command)).toEqual(found.map((r) => r.command));
    for (const r of rows) expect(r.directory).toBeTruthy();
    const status = (await view(app)).status!;
    expect(status.state).toBe(found.length ? "ready" : "setup");
  });

  it("says which setup has the wrong directory", async () => {
    const app = open();
    await app.plugins.install("agents", {
      agents: [
        { name: "good", command: "claude", directory: tempDir() },
        { name: "bad", command: "codex", directory: "/nope/definitely-not-here" },
      ],
    });
    const status = (await view(app)).status!;
    expect(status).toMatchObject({ state: "error" });
    expect(status.message).toContain("bad");
    expect(status.message).not.toContain("good:");
  });

  it("confirms before handing work over, and refuses what it cannot do", async () => {
    const app = open();
    await app.plugins.install("agents", { agents: [{ name: "work", command: "claude" }] });
    const tool = app.tools.get("coding_agent_run")!;
    expect(await tool.confirm!({ task: "fix the failing test" } as never, {} as ToolContext)).toBe(true);
    await expect(tool.run({ task: "fix the failing test" } as never, {} as ToolContext)).rejects.toThrow(/directory for “work”/);

    await app.plugins.install("agents", { agents: [{ name: "work", command: "claude", directory: tempDir() }] });
    await expect(tool.run({ task: "x", agent: "nope" } as never, {} as ToolContext)).rejects.toThrow(/No agent named/);
  });

  it("reads a setup's row: defaults, wrappers in the environment, comments", async () => {
    const p = readProfile({ command: "claude", env: "CLAUDE_CODE_EXECUTABLE=ak-bili-claude\n# a comment\nCODEX_PATH=ak-bilicodex\n\nEMPTY=\nMODEL=x\nINVALID LINE" });
    expect(p.name).toBe("claude");
    expect(p.mode).toBe("edits");
    expect(p.timeoutSeconds).toBe(1800);
    expect(p.env).toEqual({ CLAUDE_CODE_EXECUTABLE: "ak-bili-claude", CODEX_PATH: "ak-bilicodex", EMPTY: "", MODEL: "x" });

    const q = readProfile({ name: "bili", command: "claude", timeout: "60", mode: "read-only", env: "CLAUDE_CODE_EXECUTABLE=ak-bili-claude" }, 1);
    expect(q).toMatchObject({ name: "bili", mode: "read-only", directory: "" });
    expect(q.timeoutSeconds).toBe(60);
    expect(q.model).toBeUndefined();
    expect(q.env).toEqual({ CLAUDE_CODE_EXECUTABLE: "ak-bili-claude" });
  });

  it("never lets a call ask for more than the setup allows", async () => {
    const app = open();
    const dir = tempDir();
    await app.plugins.install("agents", { agents: [{ name: "work", command: "claude", directory: dir, mode: "read-only" }] });
    const tool = app.tools.get("coding_agent_run")!;
    await expect(tool.run({ task: "x", mode: "full" } as never, {} as ToolContext)).rejects.toThrow(/cannot ask for full/);
    expect(tool.summarize!({ task: "x", mode: "full" } as never)).toContain("allowed read only");
    expect(tool.summarize!({ task: "x" } as never)).toContain(dir);
  });

  it("tells the owner, before a run, what Codex and pi do without asking", async () => {
    const app = open();
    await app.plugins.install("agents", {
      agents: [
        { name: "c", command: "codex", directory: tempDir(), mode: "edits" },
        { name: "p", command: "pi", directory: tempDir(), mode: "edits" },
        { name: "f", command: "pi", directory: tempDir(), mode: "full" },
        { name: "k", command: "claude", directory: tempDir(), mode: "edits" },
      ],
    });
    const run = app.tools.get("coding_agent_run")!;
    expect(run.summarize!({ task: "x", agent: "c" } as never)).toContain("Codex runs shell commands inside the repository without asking");
    expect(run.summarize!({ task: "x", agent: "p" } as never)).toContain("pi runs every tool");
    expect(run.summarize!({ task: "x", agent: "f" } as never)).not.toContain("without asking");
    expect(run.summarize!({ task: "x", agent: "k" } as never)).not.toContain("without asking");
    const details = (await view(app)).status!.details!;
    expect(details.find((d) => d.label === "p")!.value).toContain("without asking");
  });

  it("finds a session by its setup even when the setup's name has a colon", async () => {
    const app = open();
    await app.plugins.install("agents", {
      agents: [
        { name: "a", command: "claude", directory: tempDir() },
        { name: "a:b", command: "codex", directory: tempDir(), mode: "read-only" },
      ],
    });
    const send = app.tools.get("coding_agent_send")!;
    expect(send.summarize!({ session: "a:b:fix", task: "go" } as never)).toContain("allowed read only");
    expect(send.summarize!({ session: "a:fix", task: "go" } as never)).toContain("allowed reads, searches, edits");
  });

  it("keeps credentials in a setup's environment out of what the model reads", async () => {
    const app = open();
    await app.plugins.install("agents", {
      agents: [{ name: "work", command: "claude", directory: tempDir(), env: "ANTHROPIC_API_KEY=sk-test-123456\nCLAUDE_CODE_EXECUTABLE=my-claude" }],
    });
    expect(app.vault.redact("key sk-test-123456 via my-claude")).toBe("key [secret] via my-claude");
  });

  it("decides each permission request by the mode", () => {
    expect(permissionFor("full", "execute")).toBe("allow");
    expect(permissionFor("edits", "read")).toBe("allow");
    expect(permissionFor("edits", "edit", { cwd: "/repo", paths: ["/repo/a.ts"] })).toBe("allow");
    // A shell command or a delete waits for the owner in the edits mode, and an unnamed kind never slips through.
    expect(permissionFor("edits", "execute")).toBe("ask");
    expect(permissionFor("edits", "delete")).toBe("ask");
    expect(permissionFor("edits", undefined)).toBe("ask");
    expect(permissionFor("read-only", "read")).toBe("allow");
    expect(permissionFor("read-only", "edit")).toBe("deny");
    expect(permissionFor("read-only", "execute")).toBe("deny");
  });

  it("lets an edit through unasked only inside the working directory, where nothing runs it by itself", () => {
    const home = tempDir();
    const repo = join(home, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    symlinkSync(join(home, ".zshrc"), join(repo, "src", "rc"));
    const edit = (...paths: string[]) => permissionFor("edits", "edit", { cwd: repo, paths: paths.map((p) => resolve(repo, p)) });
    const where = (p: string) => insideWorkdir(repo, p, home);
    expect(where("src/new.ts")).toBe(true);
    expect(where(join(repo, "README.md"))).toBe(true);
    // Outside, through a symlink, or where Git and the agents run what is written.
    expect(where("../.zshrc")).toBe(false);
    expect(where(join(home, "Library/LaunchAgents/x.plist"))).toBe(false);
    expect(where("src/rc")).toBe(false);
    for (const p of [".git/hooks/pre-commit", ".git/config", ".claude/settings.json", ".codex/config.toml"]) expect(where(p), p).toBe(false);
    // With the home directory as the workdir, every edit asks.
    expect(insideWorkdir(home, join(home, "notes.md"), home)).toBe(false);
    // One path outside, or none named, is enough to ask.
    expect(edit()).toBe("ask");
    expect(permissionFor("edits", "edit")).toBe("ask");
    expect(permissionFor("edits", "move", { cwd: repo, paths: [join(repo, "a"), "/etc/x"] })).toBe("ask");
    expect(permissionFor("full", "edit", { cwd: repo, paths: ["/etc/x"] })).toBe("allow");

    const request = (toolCall: object) => ({ sessionId: "s", inferredKind: "edit", raw: { sessionId: "s", options: [], toolCall } }) as never;
    expect(requestPaths(request({ toolCallId: "1", locations: [{ path: "/repo/a.ts" }], rawInput: { file_path: "/repo/b.ts", new_path: "/x/c", content: "/not/a/path" } }))).toEqual(["/repo/a.ts", "/repo/b.ts", "/x/c"]);
  });

  it("keeps Vireo's own settings out of the agent's environment", () => {
    const env = agentEnv({ PATH: "/bin", VIREO_DATA_DIR: "/d", GOOGLE_CLIENT_SECRET: "s", ANTHROPIC_API_KEY: "k" }, { EXTRA: "1" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", EXTRA: "1" });
    // acpx starts the agent from Vireo's own environment, so its keys can only be blanked there.
    expect(agentOverlay({ PATH: "/bin", VIREO_DATA_DIR: "/d" }, { EXTRA: "1" })).toEqual({ VIREO_DATA_DIR: "", EXTRA: "1" });
  });

  it("keeps tool calls up to date past the cap, and the plan as its latest version", () => {
    const reader = new TurnReader();
    for (let i = 0; i < 70; i++) reader.push({ type: "tool_call", text: "", toolCallId: `t${i}`, title: `step ${i}`, status: "pending" });
    for (let i = 0; i < 70; i++) reader.push({ type: "tool_call", text: "", toolCallId: `t${i}`, status: "completed" });
    reader.push({ type: "status", text: "plan updated", tag: "plan", entries: [{ content: "read", status: "in_progress" }] });
    reader.push({ type: "status", text: "plan updated", tag: "plan", entries: [{ content: "read", status: "completed" }, { content: "edit", status: "pending" }] });
    const turn = reader.finish();
    expect(turn.tools).toHaveLength(60);
    expect(turn.tools.every((t) => t.status === "completed")).toBe(true);
    expect(turn.plans).toEqual(["completed: read", "pending: edit"]);
  });

  it("says what the agent is doing now, and records the tokens it reported", () => {
    const reader = new TurnReader();
    expect(reader.push({ type: "tool_call", text: "Run mkdir", toolCallId: "t1", title: "Run mkdir", status: "pending" })).toBe("Run mkdir");
    // A status change to the same step does not repeat its title.
    expect(reader.push({ type: "tool_call", text: "", toolCallId: "t1", title: "tool call", status: "completed" })).toBeUndefined();
    reader.push({ type: "status", text: "usage updated", tag: "usage_update", breakdown: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80 } });
    const turn = reader.finish();
    expect(turn.tools[0]).toMatchObject({ title: "Run mkdir", status: "completed" });
    expect(turn.usage).toEqual({ input: 100, output: 20, cached: 80 });
  });

  it("records the tokens on the agent's result when no usage event carried them", () => {
    const reader = new TurnReader();
    // Claude Code and Codex report a usage event with only the context size, then the turn's tokens on the result.
    reader.push({ type: "status", text: "usage updated: 1/1000000", tag: "usage_update", used: 1, size: 1_000_000 });
    reader.end({
      status: "completed",
      stopReason: "end_turn",
      _meta: {
        quota: {
          token_count: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, cachedWriteTokens: 5 },
          model_usage: [{ model: "gpt-6-astra" }],
        },
      },
    });
    const turn = reader.finish();
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.usage).toEqual({ model: "gpt-6-astra", input: 100, output: 20, cached: 80, cacheWrite: 5 });
  });

  it("prefers the result's count over a usage event's, since the result counts the whole turn", () => {
    const reader = new TurnReader();
    reader.push({ type: "status", text: "usage updated", tag: "usage_update", breakdown: { inputTokens: 10, outputTokens: 2 } });
    reader.end({ status: "completed", _meta: { quota: { token_count: { inputTokens: 100, outputTokens: 20 } } } });
    expect(reader.finish().usage).toMatchObject({ input: 100, output: 20 });
  });

  it("keeps a setup's runtime when a call narrows the mode, and replaces it when the setup changes", async () => {
    const agents = new AcpAgents(tempDir());
    const base: AgentSpec = { name: "work", command: "claude", cwd: tempDir(), mode: "full", env: {} };
    const full = agents.runtime(base);
    const edits = agents.runtime({ ...base, mode: "edits" });
    expect(edits).not.toBe(full);
    expect(agents.runtime(base)).toBe(full);
    expect(agents.runtime({ ...base, env: { X: "1" } })).not.toBe(full);
    await agents.shutdown();
  });
});
