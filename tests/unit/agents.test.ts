import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { agentEnv, execArgs, parseTurn, sessionPromptArgs, type RunOptions } from "../../apps/node/src/acp.js";
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

  it("names its own command with --agent and no positional agent", () => {
    const o: RunOptions = { cwd: "/r", mode: "edits", timeoutSeconds: 60, ttlSeconds: 60, agentCommand: "my-wrapper --acp" };
    const own = execArgs("my-wrapper --acp", "do it", o);
    expect(own.slice(own.indexOf("--agent"), own.indexOf("--agent") + 2)).toEqual(["--agent", "my-wrapper --acp"]);
    expect(own.slice(-2)).toEqual(["exec", "do it"]);
    expect(own.filter((a) => a === "my-wrapper --acp")).toHaveLength(1);

    const builtIn = sessionPromptArgs("claude", "work:fix", "go", { ...o, agentCommand: undefined });
    expect(builtIn.slice(-5)).toEqual(["claude", "-s", "work:fix", "prompt", "go"]);
    expect(builtIn).not.toContain("--agent");
  });

  it("keeps Vireo's own settings out of the agent's environment", () => {
    const env = agentEnv({ PATH: "/bin", VIREO_DATA_DIR: "/d", GOOGLE_CLIENT_SECRET: "s", ANTHROPIC_API_KEY: "k" }, { EXTRA: "1" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", EXTRA: "1" });
  });

  it("keeps tool calls up to date past the cap, and the plan as its latest version", () => {
    const frame = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } });
    const lines: string[] = [];
    for (let i = 0; i < 70; i++) lines.push(frame({ sessionUpdate: "tool_call", toolCallId: `t${i}`, title: `step ${i}`, status: "pending" }));
    for (let i = 0; i < 70; i++) lines.push(frame({ sessionUpdate: "tool_call_update", toolCallId: `t${i}`, status: "completed" }));
    lines.push(frame({ sessionUpdate: "plan", entries: [{ content: "read", status: "in_progress" }] }));
    lines.push(frame({ sessionUpdate: "plan", entries: [{ content: "read", status: "completed" }, { content: "edit", status: "pending" }] }));
    const turn = parseTurn(lines.join("\n"));
    expect(turn.tools).toHaveLength(60);
    expect(turn.tools.every((t) => t.status === "completed")).toBe(true);
    expect(turn.plans).toEqual(["completed: read", "pending: edit"]);
  });
});
