import type { ImageContent } from "./messages.js";
import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { IncomingMessage } from "node:http";
import type { App } from "./app.js";
import type { OwnerInput } from "./browser.js";
import { seenContexts } from "./fake-model.js";
import { bus, type BusEvent } from "./bus.js";
import { hostName, hostUrls, pairingInstructions } from "./pairing.js";
import { OVERVIEW_ID, type StoredMessage } from "./threads.js";
import { errorMessage, newId, now, truncate } from "./util.js";

type Env = { Bindings: { incoming: IncomingMessage } };

const COOKIE = "vireo_session";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * The address of the person making the request. Proxies on this machine (the
 * Vireo app, Caddy) append the address they saw to X-Forwarded-For, so the
 * right-most entry that is not loopback is the real client; entries further
 * left are client-supplied and ignored.
 */
function clientIp(c: Context<Env>): string {
  const addr = c.env?.incoming?.socket?.remoteAddress ?? "?";
  if (!LOOPBACK.has(addr)) return addr;
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.reverse().find((h) => !LOOPBACK.has(h)) ?? addr;
}

function isLoopback(c: Context<Env>): boolean {
  return LOOPBACK.has(clientIp(c));
}

function tokenOf(c: Context): string | undefined {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return getCookie(c, COOKIE) ?? c.req.query("token") ?? undefined;
}

function secureRequest(c: Context): boolean {
  return c.req.url.startsWith("https:") || c.req.header("x-forwarded-proto") === "https";
}

/** Shapes stored messages for the UI. */
export function viewMessage(m: StoredMessage) {
  const b = m.body as unknown as Record<string, unknown>;
  if (m.role === "notice") {
    return { id: m.id, role: "notice", kind: b.kind, text: b.text, data: b.data ?? null, createdAt: m.createdAt };
  }
  if (m.role === "user") {
    const content = b.content as string | { type: string; text?: string; mimeType?: string; data?: string }[];
    const text = typeof content === "string" ? content : content.filter((x) => x.type === "text").map((x) => x.text).join("");
    const images = typeof content === "string" ? [] : content.filter((x) => x.type === "image").map((x) => `data:${x.mimeType};base64,${x.data}`);
    return { id: m.id, role: "user", text, images, fromVireo: m.agent === "vireo", createdAt: m.createdAt };
  }
  if (m.role === "assistant") {
    const content = b.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
    return {
      id: m.id,
      role: "assistant",
      agent: m.agent,
      text: content.filter((x) => x.type === "text").map((x) => x.text).join(""),
      thinking: content.filter((x) => x.type === "thinking").map((x) => x.thinking).join("") || undefined,
      toolCalls: content.filter((x) => x.type === "toolCall").map((x) => ({ id: x.id, name: x.name, args: x.arguments })),
      createdAt: m.createdAt,
    };
  }
  const content = (b.content as { type: string; text?: string }[]) ?? [];
  return {
    id: m.id,
    role: "tool",
    toolCallId: b.toolCallId,
    toolName: b.toolName,
    isError: b.isError,
    text: truncate(content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), 3000),
    awaitingConfirmation: (b.details as { awaitingConfirmation?: string } | undefined)?.awaitingConfirmation,
    createdAt: m.createdAt,
  };
}

export function createHttp(app: App): Hono<Env> {
  const api = new Hono<Env>();

  api.onError((err, c) => {
    console.error("[http]", err);
    return c.json({ error: errorMessage(err) }, 400);
  });

  // Vireo apps on other origins reach this host with a Bearer token from
  // pairing. Cross-origin requests carry no cookies, so this opens no CSRF path.
  api.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
          vary: "origin",
        },
      });
    }
    await next();
    c.res.headers.set("access-control-allow-origin", origin);
    c.res.headers.append("vary", "origin");
  });

  // ---- public ----
  api.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));

  api.get("/api/auth/status", (c) =>
    c.json({
      hasOwner: app.auth.hasOwner(),
      authenticated: app.auth.check(tokenOf(c)),
      setupNeedsCode: !isLoopback(c) && !app.config.testMode,
      name: hostName(app.config),
    }),
  );

  const startSession = (c: Context<Env>, label: string) => {
    const token = app.auth.createSession(label || c.req.header("user-agent") || "device");
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureRequest(c),
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return token;
  };

  api.post("/api/auth/setup", async (c) => {
    if (app.auth.hasOwner()) return c.json({ error: "Already set up" }, 409);
    const body = await c.req.json<{ password: string; code?: string; timezone?: string }>();
    if (!isLoopback(c) && !app.config.testMode && body.code?.trim() !== app.auth.setupCode) {
      return c.json({ error: "Wrong setup code. It is printed in the server log." }, 403);
    }
    app.auth.setPassword(body.password);
    if (body.timezone) app.settings.update({ timezone: body.timezone });
    const token = startSession(c, c.req.header("user-agent") ?? "device");
    return c.json({ ok: true, token });
  });

  const attempts = new Map<string, { n: number; at: number }>();
  const throttle = (c: Context<Env>) => {
    const ip = clientIp(c);
    const a = attempts.get(ip) ?? { n: 0, at: now() };
    if (now() - a.at > 15 * 60_000) Object.assign(a, { n: 0, at: now() });
    return {
      blocked: a.n >= 10,
      fail: () => {
        a.n += 1;
        attempts.set(ip, a);
      },
      ok: () => attempts.delete(ip),
    };
  };
  api.post("/api/auth/login", async (c) => {
    const a = throttle(c);
    if (a.blocked) return c.json({ error: "Too many attempts. Try again later." }, 429);
    const body = await c.req.json<{ password: string; label?: string }>();
    if (!app.auth.verify(body.password ?? "")) {
      a.fail();
      return c.json({ error: "Wrong password" }, 401);
    }
    a.ok();
    return c.json({ ok: true, token: startSession(c, body.label ?? "") });
  });

  // Trades a one-time pairing code for a session token (no password needed).
  api.post("/api/auth/pair", async (c) => {
    const a = throttle(c);
    if (a.blocked) return c.json({ error: "Too many attempts. Try again later." }, 429);
    const body = await c.req.json<{ code?: string; label?: string; timezone?: string }>();
    if (!app.pairing.redeem(body.code ?? "")) {
      a.fail();
      return c.json({ error: "That pairing code is wrong or has expired. Run `npm run pair` on the host for a new one." }, 401);
    }
    a.ok();
    if (body.timezone && !app.auth.hasOwner()) app.settings.update({ timezone: body.timezone });
    const token = startSession(c, `Paired: ${body.label || c.req.header("user-agent") || "device"}`);
    console.log(`[pairing] paired ${body.label || "a device"}`);
    return c.json({ ok: true, token, name: hostName(app.config) });
  });

  api.post("/api/auth/logout", (c) => {
    const t = tokenOf(c);
    if (t) app.auth.revoke(t);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Plugin callbacks (OAuth); each checks its own state parameter.
  app.plugins.publicRoutes(api as unknown as Hono);

  // ---- everything below requires the owner ----
  const requireOwner = async (c: Context<Env>, next: Next) => {
    if (!app.auth.check(tokenOf(c))) return c.json({ error: "Not signed in" }, 401);
    await next();
  };
  api.use("/api/*", requireOwner);

  api.get("/api/me", (c) =>
    c.json({
      settings: app.settings.get(),
      models: app.models.status(),
      integrations: app.integrations.status(),
      push: { publicKey: app.push.publicKey, subscriptions: app.push.count() },
      testMode: app.config.testMode,
    }),
  );

  // SSE stream of live updates for every open device (N3).
  api.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: BusEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = bus.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20000))]);
          wake = undefined;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: String(now()) });
            continue;
          }
        }
        const batch = queue.splice(0, queue.length);
        for (const e of batch) await stream.writeSSE({ event: "message", data: JSON.stringify(e) });
      }
      unsubscribe();
    }),
  );

  // ---- threads ----
  api.get("/api/threads", (c) => c.json({ threads: app.threads.list() }));

  api.post("/api/threads", async (c) => {
    const body = await c.req.json<{ text?: string; temporary?: boolean; title?: string }>();
    const thread = app.threads.create({ temporary: body.temporary, title: body.title });
    if (body.text?.trim()) app.runner.send(thread.id, body.text.trim());
    return c.json({ thread: app.threads.get(thread.id) });
  });

  api.get("/api/threads/:id", (c) => {
    const id = c.req.param("id");
    const thread = app.threads.get(id);
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json({
      thread,
      messages: app.threads.messages(id).map((m) => {
        const v = viewMessage(m);
        // What Vireo remembered from this thread, minus what the owner has since taken back.
        if (m.role === "notice" && "kind" in v && v.kind === "remembered" && v.data) {
          const facts = (v.data as { facts?: { id: string; statement: string }[] }).facts ?? [];
          return { ...v, data: { facts: facts.map((f) => ({ ...f, forgotten: !app.memory.fact(f.id) })) } };
        }
        return v;
      }),
      actions: app.actions.forThread(id),
      related: app.threads.related(id),
      files: app.files.forThread(id),
      procedures: app.db.all("SELECT * FROM procedures WHERE source_thread_id = ?", id),
      cards: app.cards.forThread(id),
    });
  });

  api.patch("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string; temporary?: boolean }>();
    if (body.title) app.threads.update(id, { title: body.title.slice(0, 80), titled: 1 });
    if (body.temporary !== undefined && id !== OVERVIEW_ID) app.threads.update(id, { temporary: body.temporary ? 1 : 0 });
    return c.json({ thread: app.threads.get(id) });
  });

  api.delete("/api/threads/:id", (c) => {
    app.threads.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.post("/api/threads/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ text: string; fileIds?: string[] }>();
    const images: ImageContent[] = [];
    for (const fid of body.fileIds ?? []) {
      const f = app.files.read(fid);
      if (f && f.info.mime.startsWith("image/") && f.data.length < 5_000_000) {
        images.push({ type: "image", data: f.data.toString("base64"), mimeType: f.info.mime });
      }
    }
    const msg = app.runner.send(id, body.text ?? "", { fileIds: body.fileIds, images });
    return c.json({ message: viewMessage(msg) });
  });

  api.post("/api/threads/:id/done", async (c) => {
    await app.runner.complete(c.req.param("id"));
    return c.json({ thread: app.threads.get(c.req.param("id")) });
  });
  api.post("/api/threads/:id/reopen", (c) => {
    app.runner.reopen(c.req.param("id"));
    return c.json({ thread: app.threads.get(c.req.param("id")) });
  });
  api.post("/api/threads/:id/stop", (c) => {
    app.runner.stop(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/api/threads/:id/retry", (c) => {
    app.runner.schedule(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/api/threads/:id/audit", (c) => {
    const id = c.req.param("id");
    return c.json({
      toolCalls: app.db.all("SELECT * FROM tool_calls WHERE thread_id = ? ORDER BY id", id),
      llmCalls: app.db
        .all<{ model: string; input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number }>("SELECT * FROM llm_calls WHERE thread_id = ? ORDER BY id", id)
        .map((r) => ({
          ...r,
          cost: app.pricing.cost(r.model, { input: r.input_tokens, cached: r.cached_tokens, cacheWrite: r.cache_write_tokens, output: r.output_tokens }) ?? null,
        })),
    });
  });

  // Token use and cost by model; the overview reports every thread. Context is the thread's latest prompt size.
  api.get("/api/threads/:id/usage", (c) => {
    const id = c.req.param("id");
    const all = id === OVERVIEW_ID;
    const rows = app.db.all<{ model: string; calls: number; input: number; cached: number; cache_write: number; output: number }>(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(cache_write_tokens) AS cache_write, SUM(output_tokens) AS output
       FROM llm_calls ${all ? "" : "WHERE thread_id = ?"} GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC`,
      ...(all ? [] : [id]),
    );
    const models = rows.map((r) => {
      const t = { input: r.input ?? 0, cached: r.cached ?? 0, cacheWrite: r.cache_write ?? 0, output: r.output ?? 0 };
      return { model: r.model ?? "unknown", calls: r.calls, ...t, cost: app.pricing.cost(r.model, t) ?? null };
    });
    const last = app.db.get<{ model: string; input_tokens: number; output_tokens: number }>(
      "SELECT model, input_tokens, output_tokens FROM llm_calls WHERE thread_id = ? AND purpose = 'agent' AND error IS NULL AND input_tokens > 0 ORDER BY id DESC LIMIT 1",
      id,
    );
    const ctxModel = last?.model ?? app.models.mainModel();
    return c.json({
      scope: all ? "all" : "thread",
      models,
      context: ctxModel ? { model: ctxModel, used: last ? last.input_tokens + last.output_tokens : 0, limit: app.pricing.lookup(ctxModel)?.context ?? null } : null,
    });
  });

  api.get("/api/threads/:id/browser", async (c) => {
    const frame = await app.browser.frame(c.req.param("id"));
    if (!frame) return c.json({ error: "No browser activity" }, 404);
    return new Response(new Uint8Array(frame), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  });

  api.get("/api/threads/:id/browser/control", (c) => {
    const id = c.req.param("id");
    return c.json({ page: app.browser.hasPage(id), controlled: app.browser.isControlled(id) });
  });

  api.post("/api/threads/:id/browser/control", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({ on: undefined }));
    if (body.on) {
      if (!app.browser.takeOver(id)) return c.json({ error: "There is no open page to take over" }, 409);
    } else {
      app.browser.handBack(id);
    }
    return c.json({ page: app.browser.hasPage(id), controlled: app.browser.isControlled(id) });
  });

  api.post("/api/threads/:id/browser/input", async (c) => {
    const id = c.req.param("id");
    if (!app.browser.isControlled(id)) return c.json({ error: "Take over the browser first" }, 409);
    const ev = await c.req.json<OwnerInput>().catch(() => null);
    const ok =
      ev &&
      (((ev.type === "move" || ev.type === "down" || ev.type === "up") && typeof ev.x === "number" && typeof ev.y === "number") ||
        (ev.type === "wheel" && typeof ev.dx === "number" && typeof ev.dy === "number") ||
        (ev.type === "key" && typeof ev.key === "string" && ev.key.length <= 40) ||
        (ev.type === "text" && typeof ev.text === "string" && ev.text.length <= 10_000));
    if (!ok) return c.json({ error: "Unknown input" }, 400);
    if ((ev.type === "down" || ev.type === "up") && ev.button && !["left", "middle", "right"].includes(ev.button)) return c.json({ error: "Unknown button" }, 400);
    try {
      await app.browser.input(id, ev);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return c.json({ ok: true });
  });

  api.post("/api/threads/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!app.threads.get(id)) return c.json({ error: "Not found" }, 404);
    const form = await c.req.formData();
    const out = [];
    for (const value of form.getAll("file")) {
      if (typeof value === "string") continue;
      const data = Buffer.from(await value.arrayBuffer());
      if (data.length > 20_000_000) return c.json({ error: `${value.name} is larger than 20 MB` }, 413);
      out.push(app.files.save({ threadId: id, name: value.name, mime: value.type || "application/octet-stream", data, origin: "upload" }));
    }
    return c.json({ files: out });
  });

  api.get("/api/files/:id", (c) => {
    const f = app.files.read(c.req.param("id"));
    if (!f) return c.json({ error: "Not found" }, 404);
    const inline = f.info.mime.startsWith("image/") || c.req.query("inline") === "1";
    return new Response(new Uint8Array(f.data), {
      headers: {
        "content-type": f.info.mime,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.info.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  });

  // ---- confirmations ----
  // ---- cards ----
  api.get("/api/cards", (c) => c.json({ cards: app.cards.feed() }));
  api.post("/api/cards/:id/archive", (c) => {
    const ok = app.cards.archive(c.req.param("id"));
    return ok ? c.json({ ok }) : c.json({ error: "Not found" }, 404);
  });

  api.get("/api/actions", (c) => c.json({ actions: app.actions.pending() }));
  api.post("/api/actions/:id/confirm", async (c) => {
    const body = await c.req.json<{ args?: Record<string, unknown> }>().catch(() => ({}) as { args?: Record<string, unknown> });
    return c.json({ action: await app.actions.confirm(c.req.param("id"), body.args) });
  });
  api.post("/api/actions/:id/cancel", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return c.json({ action: app.actions.cancel(c.req.param("id"), body.reason) });
  });

  // ---- memory ----
  api.get("/api/memory", (c) => {
    const query = c.req.query("query") || undefined;
    const history = c.req.query("history") === "1";
    return c.json({
      facts: app.memory.list({ query, includeHistory: history }),
      entities: app.memory.entities(),
      episodes: app.memory.episodes({ query, limit: 30 }),
    });
  });
  api.get("/api/memory/facts/:id/history", (c) => c.json({ history: app.memory.history(c.req.param("id")) }));
  api.patch("/api/memory/facts/:id", async (c) => {
    const body = await c.req.json<{ statement: string }>();
    return c.json({ fact: app.memory.correct(c.req.param("id"), body.statement) });
  });
  api.delete("/api/memory/facts/:id", (c) => c.json({ ok: app.memory.delete(c.req.param("id")) }));
  api.delete("/api/memory/entities/:id", (c) => {
    app.memory.deleteEntity(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/api/memory/facts", async (c) => {
    const body = await c.req.json<{ statement: string; key?: string; about?: string }>();
    const episodeId = app.memory.addEpisode({ source: "owner_edit", content: `Owner added: ${body.statement}` });
    return c.json({ fact: app.memory.addFact({ statement: body.statement, key: body.key, entity: body.about, episodeId }).fact });
  });

  // ---- procedures ----
  api.get("/api/procedures", (c) => c.json({ procedures: app.db.all("SELECT * FROM procedures ORDER BY updated_at DESC") }));
  api.post("/api/procedures/:id/:decision{approve|reject}", (c) => {
    const status = c.req.param("decision") === "approve" ? "approved" : "rejected";
    app.db.run("UPDATE procedures SET status = ?, updated_at = ? WHERE id = ?", status, now(), c.req.param("id"));
    bus.publish({ type: "procedure.updated" });
    return c.json({ ok: true });
  });
  api.patch("/api/procedures/:id", async (c) => {
    const body = await c.req.json<{ name?: string; description?: string; steps?: string }>();
    const cur = app.db.get<{ name: string; description: string; steps: string }>("SELECT * FROM procedures WHERE id = ?", c.req.param("id"));
    if (!cur) return c.json({ error: "Not found" }, 404);
    app.db.run(
      "UPDATE procedures SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ?",
      body.name ?? cur.name,
      body.description ?? cur.description,
      body.steps ?? cur.steps,
      now(),
      c.req.param("id"),
    );
    bus.publish({ type: "procedure.updated" });
    return c.json({ ok: true });
  });
  api.delete("/api/procedures/:id", (c) => {
    app.db.run("DELETE FROM procedures WHERE id = ?", c.req.param("id"));
    bus.publish({ type: "procedure.updated" });
    return c.json({ ok: true });
  });

  // ---- settings ----
  api.get("/api/settings", (c) => c.json(app.settings.get()));
  api.patch("/api/settings", async (c) => c.json(app.settings.update(await c.req.json())));

  // ---- models (any OpenAI-compatible endpoint) ----
  api.get("/api/models", async (c) => {
    await app.models.refresh();
    return c.json(app.models.status());
  });
  api.put("/api/models", async (c) => c.json(await app.models.save(await c.req.json())));
  api.post("/api/models/test", async (c) => c.json(await app.models.test()));

  // ---- plugins ----
  const requestInfo = (c: Context<Env>) => ({
    origin: app.config.publicUrl ?? new URL(c.req.url).origin.replace(/^http:/, c.req.header("x-forwarded-proto") === "https" ? "https:" : "http:"),
    appOrigin: c.req.header("origin") ?? (c.req.header("referer") ? new URL(c.req.header("referer")!).origin : undefined),
  });
  api.get("/api/plugins", async (c) => c.json({ plugins: await app.plugins.list(requestInfo(c)) }));
  api.post("/api/plugins/:id", async (c) => {
    await app.plugins.install(c.req.param("id"), (await c.req.json<{ config?: Record<string, unknown> }>().catch(() => ({ config: {} }))).config ?? {});
    return c.json({ ok: true });
  });
  api.patch("/api/plugins/:id", async (c) => {
    await app.plugins.configure(c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  api.delete("/api/plugins/:id", async (c) => {
    await app.plugins.uninstall(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/api/plugins/:id/actions/:action", async (c) => c.json(await app.plugins.action(c.req.param("id"), c.req.param("action"), requestInfo(c))));

  // ---- credentials for browser work ----
  api.get("/api/credentials", (c) => c.json({ credentials: app.vault.list() }));
  api.post("/api/credentials", async (c) => {
    const body = await c.req.json<{ domain: string; username: string; password: string }>();
    return c.json({ credential: app.vault.add(body.domain, body.username, body.password) });
  });
  api.delete("/api/credentials/:id", (c) => {
    app.vault.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- push ----
  api.post("/api/push/subscribe", async (c) => {
    app.push.subscribe(await c.req.json());
    return c.json({ ok: true });
  });
  api.post("/api/push/unsubscribe", async (c) => {
    app.push.unsubscribe((await c.req.json<{ endpoint: string }>()).endpoint);
    return c.json({ ok: true });
  });
  api.post("/api/push/test", async (c) => {
    await app.push.notify({ title: "Vireo", body: "Notifications are working.", url: "/" });
    return c.json({ ok: true });
  });

  // ---- proactive ----
  api.post("/api/reminders/:id/cancel", (c) => {
    const id = c.req.param("id");
    const r = app.db.get<{ thread_id: string | null }>("SELECT thread_id FROM reminders WHERE id = ? AND status = 'scheduled'", id);
    if (!r) return c.json({ error: "Not found" }, 404);
    app.db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", id);
    if (r.thread_id) app.threads.changed(r.thread_id);
    bus.publish({ type: "card.updated", threadId: r.thread_id ?? OVERVIEW_ID, cardId: `reminder:${id}` });
    return c.json({ ok: true });
  });
  api.get("/api/reminders", (c) => c.json({ reminders: app.db.all("SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY due_at") }));

  // ---- observability (N7) ----
  api.get("/api/usage", (c) =>
    c.json({
      byPurpose: app.db.all(
        "SELECT purpose, provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost) AS cost, AVG(duration_ms) AS avg_ms FROM llm_calls GROUP BY purpose, provider, model ORDER BY cost DESC",
      ),
      last7days: app.db.get("SELECT COUNT(*) AS calls, SUM(cost) AS cost FROM llm_calls WHERE created_at > ?", now() - 7 * 864e5),
    }),
  );
  api.get("/api/sessions", (c) => c.json({ sessions: app.auth.sessions() }));

  // A paired device hands out a code so another device can pair with this host.
  api.post("/api/pairing", (c) => {
    const { code, expiresAt } = app.pairing.create();
    for (const line of pairingInstructions(app.config, code)) console.log(line);
    return c.json({ code, expiresAt, urls: hostUrls(app.config), name: hostName(app.config) });
  });

  if (app.config.testMode) mountTestRoutes(api, app);

  // The host has no UI; the Vireo app (web/) is served separately.
  api.get("*", (c) =>
    c.text(`${hostName(app.config)} is a Vireo host. Open the Vireo app and choose Add host, then enter this address and a pairing code from the host's log (or run \`npm run pair\` on it).\n`),
  );
  return api;
}

/** Endpoints only available with VIREO_TEST_MODE=1, used by the end-to-end suite. */
function mountTestRoutes(api: Hono<Env>, app: App): void {
  api.post("/api/test/email", async (c) => {
    const body = await c.req.json<{ from: string; subject: string; body: string }>();
    const m = app.integrations.fakeMail?.deliver(body);
    return c.json({ email: m });
  });
  api.get("/api/test/sent", (c) => c.json({ sent: app.integrations.fakeMail?.sent ?? [], drafts: app.integrations.fakeMail?.drafts ?? [] }));
  api.post("/api/test/check-inbox", async (c) => c.json({ opened: await app.scheduler.checkInbox() }));
  api.post("/api/test/check-calendar", async (c) => c.json({ opened: await app.scheduler.checkCalendar() }));
  api.post("/api/test/reminders", async (c) => {
    const body = await c.req.json<{ at?: number }>().catch(() => ({}) as { at?: number });
    return c.json({ fired: await app.scheduler.fireReminders(body.at ?? Date.now() + 365 * 864e5) });
  });
  api.post("/api/test/nudge", async (c) => c.json(await app.scheduler.nudge()));
  api.post("/api/test/idle", async (c) => {
    for (let i = 0; i < 3; i++) {
      await app.runner.idle();
      await app.memoryWorker.flush();
    }
    return c.json({ ok: true });
  });
  api.get("/api/test/model-contexts", (c) => {
    const needle = c.req.query("contains") ?? "";
    return c.json({ total: seenContexts.length, matching: needle ? seenContexts.filter((x) => x.includes(needle)).length : 0 });
  });
  api.get("/api/test/notifications", (c) => c.json({ notifications: app.push.recent }));
  api.get("/api/test/llm-log", (c) => c.json({ calls: app.db.all("SELECT * FROM llm_calls ORDER BY id") }));
  api.post("/api/test/event", async (c) => {
    const body = await c.req.json<{ title: string; start: string; end: string; attendees?: string[] }>();
    return c.json({ event: await app.integrations.localCalendar.createEvent(body) });
  });
  api.get("/api/test/events", async (c) =>
    c.json({ events: await app.integrations.localCalendar.listEvents(new Date(0), new Date(8.64e15)) }),
  );
}
