import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { readProfile } from "../../apps/node/src/plugins/agents/index.js";
import type { ToolContext } from "../../apps/node/src/tools/types.js";
import { tempDir, testApp } from "./helpers.js";

/**
 * The coding-agents plugin: installing it adds its tools and its specialist,
 * it holds several agent setups at once, and it refuses to run until a setup
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
  it("adds its tools and specialist only while it is installed", async () => {
    const app = open();
    expect(app.tools.has("coding_agent_run")).toBe(false);

    await app.plugins.install("agents", { agents: [{ name: "work", command: "claude", directory: tempDir() }] });
    expect(app.tools.has("coding_agent_run")).toBe(true);
    expect(app.plugins.agents().map((a) => a.name)).toContain("coder");
    expect((await view(app)).status).toMatchObject({ state: "ready" });

    await app.plugins.uninstall("agents");
    expect(app.tools.has("coding_agent_run")).toBe(false);
    expect(app.plugins.agents().map((a) => a.name)).not.toContain("coder");
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

  it("starts from one Claude setup, and asks for a directory", async () => {
    const app = open();
    await app.plugins.install("agents", {});
    const status = (await view(app)).status!;
    expect(status).toMatchObject({ state: "setup" });
    expect(status.message).toContain("claude");
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
});
