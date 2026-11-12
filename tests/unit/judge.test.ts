import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { testApp } from "./helpers.js";

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

/** A Workers AI reply shaped like the real one. */
const answer = (need: number, kind = "outward") =>
  new Response(JSON.stringify({ result: { answers: { need: { type: "noul", noul: need }, kind: { type: "choice", choice: kind } } } }), { status: 200 });

function enabled() {
  const app = open();
  app.settings.update({ judgeEnabled: true, judgeAccountId: "acc-123", judgeThreshold: 0.5 });
  app.judge.saveToken("cf-token");
  return app;
}

const input = (signature: string, extra: Partial<Parameters<App["judge"]["attention"]>[0]> = {}) => ({
  tool: "send_email",
  risk: "ask" as const,
  summary: 'Send email to anna@example.com: "Lunch?"',
  target: "Email to anna@example.com",
  body: "Lunch?",
  request: "email anna about lunch",
  signature,
  ...extra,
});

describe("risk judge", () => {
  it("does nothing until it is switched on", async () => {
    const app = open();
    let calls = 0;
    app.judge.transport = async () => {
      calls++;
      return answer(0.1);
    };
    expect(await app.judge.attention(input("a"))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("asks clef-flash and gives back the probability and the kind", async () => {
    const app = enabled();
    const seen: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    app.judge.transport = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(url), body, auth: (init?.headers as Record<string, string>).authorization });
      return answer(0.12, "outward");
    };
    const verdict = await app.judge.attention(input("a"));
    expect(verdict).toMatchObject({ need: 0.12, kind: "outward" });
    expect(seen[0]!.url).toContain("/accounts/acc-123/ai/run/@cf/cloudflare/clef-flash");
    expect(seen[0]!.auth).toBe("Bearer cf-token");
    expect(seen[0]!.body).toMatchObject({ model: "clef-flash" });
    // What leaves the machine is the action, the request and the content — not the thread.
    const state = String((seen[0]!.body as { state: string }).state);
    expect(state).toContain("Lunch?");
    expect(state).toContain("email anna about lunch");
    expect(state).not.toContain("threadId");
    expect(app.judge.callsToday()).toBe(1);
  });

  it("judges the same call once and remembers the answer", async () => {
    const app = enabled();
    let calls = 0;
    app.judge.transport = async () => {
      calls++;
      return answer(0.2);
    };
    await app.judge.attention(input("same"));
    const again = await app.judge.attention(input("same"));
    expect(again).toMatchObject({ need: 0.2, note: "cached" });
    expect(calls).toBe(1);
  });

  it("keeps the card when the request fails, and says so in the log", async () => {
    const app = enabled();
    app.judge.transport = async () => new Response("nope", { status: 403 });
    expect(await app.judge.attention(input("a"))).toBeUndefined();
    expect(app.judge.recent()[0]).toMatchObject({ tool: "send_email", error: "HTTP 403" });

    app.judge.transport = async () => {
      throw new Error("network down");
    };
    expect(await app.judge.attention(input("b"))).toBeUndefined();
    expect(app.judge.recent()[0]).toMatchObject({ error: "network down" });
  });

  it("gives up quietly once the daily budget is spent", async () => {
    const app = enabled();
    app.db.setKv("judge.calls", { day: new Date().toISOString().slice(0, 10), n: 500 });
    let calls = 0;
    app.judge.transport = async () => {
      calls++;
      return answer(0.1);
    };
    expect(await app.judge.attention(input("a"))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("keeps the token encrypted and scrubs it from stored text", async () => {
    const app = enabled();
    expect(app.judge.hasToken()).toBe(true);
    expect(app.judge.secret()).toBe("cf-token");
    expect(JSON.stringify(app.db.getKv("judge.token"))).not.toContain("cf-token");
    // It is registered as a secret, so nothing written to the log can carry it.
    expect(app.vault.redact("token cf-token here")).not.toContain("cf-token");
    app.judge.saveToken("");
    expect(app.judge.hasToken()).toBe(false);
    expect(app.judge.settings().enabled).toBe(false);
  });

  it("needs an account id as well as a token", async () => {
    const app = open();
    app.settings.update({ judgeEnabled: true, judgeAccountId: "" });
    app.judge.saveToken("cf-token");
    expect(app.judge.settings().enabled).toBe(false);
  });
});
