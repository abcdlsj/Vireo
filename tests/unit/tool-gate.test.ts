import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { defineTool } from "../../apps/node/src/tools/types.js";
import { testApp } from "./helpers.js";

/** A tool call the model makes, run through the gate exactly as the runner does it. */
function caller(app: App, threadId: string) {
  let runs = 0;
  const def = defineTool({
    name: "flaky_lookup",
    label: "Flaky lookup",
    description: "Always fails the same way, like a desktop read with two windows open.",
    parameters: Type.Object({ app: Type.String(), depth: Type.Optional(Type.Number()) }),
    async run() {
      runs++;
      throw new Error("AMBIGUOUS_TARGET: More than one window matches the target");
    },
  });
  const wrapped = app.gate.wrap(def, { app, thread: app.threads.get(threadId)!, agent: "general" });
  let n = 0;
  const call = async (args: Record<string, unknown>) =>
    (await wrapped.invoke({} as never, JSON.stringify(args), { toolCall: { callId: `call_${++n}` } } as never)) as string;
  return { call, runs: () => runs };
}

let apps: App[] = [];
afterEach(() => {
  for (const app of apps) {
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

describe("repeated failing calls", () => {
  it("refuses the third identical call and says what to do instead", async () => {
    const app = open();
    const thread = app.threads.create({});
    const { call, runs } = caller(app, thread.id);

    expect(await call({ app: "企业微信" })).toContain("AMBIGUOUS_TARGET");
    expect(await call({ app: "企业微信" })).toContain("AMBIGUOUS_TARGET");

    const third = await call({ app: "企业微信" });
    expect(third).toContain("Not run");
    expect(third).toContain("already failed 2 times");
    expect(third).toContain("change approach");
    expect(third).toContain("Last error: Error: AMBIGUOUS_TARGET");
    // The tool never ran a third time.
    expect(runs()).toBe(2);

    // A different call is a fresh attempt, not the same loop.
    expect(await call({ app: "Notes" })).toContain("AMBIGUOUS_TARGET");
    expect(runs()).toBe(3);
  });

  it("treats a reordered argument list as the same call", async () => {
    const app = open();
    const thread = app.threads.create({});
    const { call, runs } = caller(app, thread.id);

    await call({ app: "企业微信", depth: 3 });
    await call({ depth: 3, app: "企业微信" });
    expect(await call({ app: "企业微信", depth: 3 })).toContain("Not run");
    expect(runs()).toBe(2);
  });

  it("starts counting again after a call that worked", async () => {
    const app = open();
    const thread = app.threads.create({});
    const def = defineTool({
      name: "sometimes_fails",
      label: "Sometimes fails",
      description: "Fails for one app and works for another.",
      parameters: Type.Object({ app: Type.String() }),
      async run(args) {
        if (args.app === "Notes") return { text: "Notes is readable" };
        throw new Error("TIMEOUT: the read did not settle");
      },
    });
    const wrapped = app.gate.wrap(def, { app, thread: app.threads.get(thread.id)!, agent: "general" });
    let id = 0;
    const call = async (name: string) => (await wrapped.invoke({} as never, JSON.stringify({ app: name }), { toolCall: { callId: `call_${++id}` } } as never)) as string;

    expect(await call("企业微信")).toContain("TIMEOUT");
    expect(await call("企业微信")).toContain("TIMEOUT");
    expect(await call("Notes")).toContain("Notes is readable");
    // The working call reset the count, so the same failing call is tried again.
    expect(await call("企业微信")).toContain("TIMEOUT");
    expect(await call("企业微信")).toContain("TIMEOUT");
    expect(await call("企业微信")).toContain("Not run");
  });
});
