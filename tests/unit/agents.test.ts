import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import type { ToolContext } from "../../apps/node/src/tools/types.js";
import { tempDir, testApp } from "./helpers.js";

/**
 * The coding-agents plugin: installing it adds its tools and its specialist,
 * and it refuses to run until the owner names a directory that exists. The
 * agents themselves are separate programs, so nothing here starts one.
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

    await app.plugins.install("agents", { directory: tempDir() });
    expect(app.tools.has("coding_agent_run")).toBe(true);
    expect(app.plugins.agents().map((a) => a.name)).toContain("coder");
    expect((await view(app)).status).toMatchObject({ state: "ready" });

    await app.plugins.uninstall("agents");
    expect(app.tools.has("coding_agent_run")).toBe(false);
    expect(app.plugins.agents().map((a) => a.name)).not.toContain("coder");
  });

  it("asks for a directory, and says so when it is not one", async () => {
    const app = open();
    await app.plugins.install("agents", {});
    expect((await view(app)).status).toMatchObject({ state: "setup" });

    await app.plugins.install("agents", { directory: "/nope/definitely-not-here" });
    expect((await view(app)).status).toMatchObject({ state: "error" });
  });

  it("confirms before handing work to an agent, and refuses without a directory", async () => {
    const app = open();
    await app.plugins.install("agents", {});
    const tool = app.tools.get("coding_agent_run")!;
    expect(await tool.confirm!({ task: "fix the failing test" } as never, {} as ToolContext)).toBe(true);
    await expect(tool.run({ task: "fix the failing test" } as never, {} as ToolContext)).rejects.toThrow(/directory to work in/);
    expect(tool.summarize?.({ task: "fix the failing test" } as never)).toContain("(no directory set)");
  });
});
