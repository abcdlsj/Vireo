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

describe("what needs the owner", () => {
  const tool = (name: string, risk: "none" | "ask" | "always" | undefined, summary: string) =>
    defineTool({
      name,
      label: name,
      description: name,
      parameters: Type.Object({ app: Type.String() }),
      risk,
      summarize: () => summary,
      async run() {
        return { text: `${name} ran` };
      },
    });

  const call = (app: App, threadId: string, def: ReturnType<typeof tool>, args: Record<string, unknown>, id: string) =>
    app.gate.wrap(def, { app, thread: app.threads.get(threadId)!, agent: "general" }).invoke({} as never, JSON.stringify(args), { toolCall: { callId: id } } as never) as Promise<string>;

  it("runs a read without a card", async () => {
    const app = open();
    const thread = app.threads.create({});
    expect(await call(app, thread.id, tool("look", "none", "Look"), { app: "Notes" }, "c1")).toContain("look ran");
    expect(app.actions.pending()).toHaveLength(0);
  });

  it("asks for an outward call", async () => {
    const app = open();
    const thread = app.threads.create({});
    const out = await call(app, thread.id, tool("send", "ask", "Send the message"), { app: "Notes" }, "c1");
    expect(out).toContain("confirmation card");
    expect(app.actions.pending()).toHaveLength(1);
  });

  it("keeps one card and rewrites it instead of stacking a second", async () => {
    const app = open();
    const thread = app.threads.create({});
    const first = await call(app, thread.id, tool("send", "ask", "Send \"hello\" to 干饭"), { app: "Notes" }, "c1");
    expect(first).toContain('A confirmation card is now shown');
    const [card] = app.actions.pending();

    const second = await call(app, thread.id, tool("send", "ask", "Send \"lunch?\" to 干饭"), { app: "Notes" }, "c2");
    expect(second).toContain("was rewritten");
    expect(second).toContain("Send \"hello\" to 干饭");

    const pending = app.actions.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(card!.id);
    expect(pending[0]!.summary).toBe('Send "lunch?" to 干饭');
    // Nothing was cancelled on the way: the owner never sees a card disappear.
    const cancelled = app.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE thread_id = ? AND status = 'cancelled'", thread.id)[0]!.n;
    expect(cancelled).toBe(0);
  });

  it("asks every time for an irreversible call, whatever the tool says", async () => {
    const app = open();
    const thread = app.threads.create({});
    await call(app, thread.id, tool("wipe", "always", "Delete the room"), { app: "Notes" }, "c1");
    expect(app.actions.pending()).toHaveLength(1);
    expect(app.actions.pending()[0]).toMatchObject({ tool: "wipe", summary: "Delete the room" });
  });

  it("stops a notification button from confirming a card that was rewritten since", async () => {
    const app = open();
    const thread = app.threads.create({});
    const card = app.actions.create(thread.id, "send", { text: "hello" }, 'Send "hello"');
    const link = new URL(app.actions.decisionUrl(card.id, "confirm"));
    expect(app.actions.verifyDecision(card.id, "confirm", link.searchParams.get("sig"))).toBe(true);

    app.actions.upsert(thread.id, "send", { text: "lunch?" }, 'Send "lunch?"');
    // The phone still shows the first text; its button must not answer the second.
    expect(app.actions.verifyDecision(card.id, "confirm", link.searchParams.get("sig"))).toBe(false);
    const fresh = new URL(app.actions.decisionUrl(card.id, "confirm"));
    expect(app.actions.verifyDecision(card.id, "confirm", fresh.searchParams.get("sig"))).toBe(true);
  });
});

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
