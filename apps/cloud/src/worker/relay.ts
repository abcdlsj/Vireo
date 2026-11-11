import type { CloudToNode, NodeToCloud } from "@vireo/protocol";
import { DurableObject } from "cloudflare:workers";
import { Channel } from "../core/channel.js";
import type { Cloud } from "../core/cloud.js";
import { offline } from "../core/hub.js";
import { cloudFor, type WorkerEnv } from "./env.js";

interface Attachment {
  nodeId: string;
  authed: boolean;
}

const PING = JSON.stringify({ t: "ping" } satisfies NodeToCloud);
const PONG = JSON.stringify({ t: "pong" } satisfies CloudToNode);

const MINUTE = 60_000;
/** Where the day's busy time is kept, and how much may pile up before it is written. */
const METER = "meter";
/** Written out often: the object hibernates between requests, and unsaved counts go with it. */
const FLUSH_MS = 5_000;

interface Meter {
  /** The UTC day this adds up within; Cloudflare's free limits reset at its midnight. */
  day: string;
  /** Milliseconds requests have held this object awake today. */
  busyMs: number;
  /** When the last live-update stream ended, for the pause between streams. */
  eventsEndedAt: number;
}

interface Limit {
  /** From this much busy time today… */
  at: number;
  /** …a live-update stream may last this long (0: not at all). */
  eventsMs: number;
  /** …and streams must be at least this far apart. */
  gapMs: number;
}

/**
 * Steps down live updates as a day's relay time grows, longest step first.
 *
 * Durable Object duration is billed for as long as a request is in flight, so
 * one stream holds this object awake — and a browser window left open on a
 * machine nobody is looking at holds one all day. The free plan allows 13,000
 * GB-s a day, which is 28 hours of this object awake at 128 MB; six hours of
 * busy time is about 2,765 GB-s and leaves the rest of the day to ordinary
 * requests. A normal day of use never reaches the first step.
 */
const LIMITS: Limit[] = [
  { at: 6 * 60 * MINUTE, eventsMs: 0, gapMs: 0 },
  { at: 4 * 60 * MINUTE, eventsMs: 5 * MINUTE, gapMs: 15_000 },
  { at: 2 * 60 * MINUTE, eventsMs: 20 * MINUTE, gapMs: 0 },
];

const limitFor = (busyMs: number): Limit => LIMITS.find((l) => busyMs >= l.at) ?? { at: 0, eventsMs: Infinity, gapMs: 0 };

const untilUtcMidnight = (): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
};

const tooMany = (ms: number): Response =>
  Response.json(
    { error: "Live updates are paused for now. The app catches up when they resume." },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) } },
  );

/**
 * One node's relay socket. The node connects at /api/nodes/:nodeId/connect
 * and says hello with its secret; the app's requests then reach it through
 * here. While nothing is in flight the object hibernates with the socket
 * open, and the node's pings are answered without waking it.
 */
export class NodeRelay extends DurableObject<WorkerEnv> {
  private bound: { ws: WebSocket; channel: Channel } | undefined;
  private meter: Meter | undefined;
  private unwritten = 0;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Today's meter, loaded from storage and reset when the UTC day turns. */
  private async today(): Promise<Meter> {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.meter || this.meter.day !== day) {
      const stored = await this.ctx.storage.get<Meter>(METER);
      this.meter = stored?.day === day ? stored : { day, busyMs: 0, eventsEndedAt: 0 };
      this.unwritten = 0;
    }
    return this.meter;
  }

  /** Charges time this object was held awake, writing it out every now and then. */
  private async spend(ms: number): Promise<void> {
    if (!(ms > 0)) return;
    const m = await this.today();
    m.busyMs += ms;
    this.unwritten += ms;
    if (this.unwritten >= FLUSH_MS) {
      this.unwritten = 0;
      await this.ctx.storage.put(METER, m);
    }
  }

  private async eventsEnded(): Promise<void> {
    const m = await this.today();
    m.eventsEndedAt = Date.now();
    await this.ctx.storage.put(METER, m);
  }

  /**
   * Passes a response through, charging its lifetime to the day and ending it
   * at the cap, so one stream cannot hold the object awake without limit.
   */
  private capped(answer: Response, started: number, capMs: number, onEnd?: () => void): Response {
    const body = answer.body;
    if (!body) {
      this.ctx.waitUntil(this.spend(Date.now() - started));
      onEnd?.();
      return answer;
    }
    const reader = body.getReader();
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (): void => {
      if (ended) return;
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      this.ctx.waitUntil(this.spend(Date.now() - started));
      onEnd?.();
    };
    if (Number.isFinite(capMs)) timer = setTimeout(() => void reader.cancel("Closed by the cloud").catch(() => undefined), capMs);
    const pass = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            end();
            c.close();
            return;
          }
          c.enqueue(value);
        } catch (err) {
          end();
          c.error(err);
        }
      },
      cancel(reason) {
        end();
        void reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(pass, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
  }

  private services(): Promise<Cloud> {
    return cloudFor(this.env, this.env.VIREO_CLOUD_URL ?? "http://localhost");
  }

  /** The node's accepted socket, if it is connected. */
  private current(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment | null)?.authed);
  }

  /** The channel for the current socket; a fresh one after the object woke from hibernation. */
  private channel(ws: WebSocket): Channel {
    if (this.bound?.ws !== ws) {
      const send = (frame: CloudToNode) => ws.send(JSON.stringify(frame));
      this.bound = { ws, channel: new Channel(send) };
    }
    return this.bound.channel;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const nodeId = /^\/api\/nodes\/([\w-]+)\/connect$/.exec(url.pathname)?.[1];
      if (!nodeId) return new Response("Not found", { status: 404 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!);
      server!.serializeAttachment({ nodeId, authed: false } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/online") return Response.json({ online: Boolean(this.current()) });
    if (url.pathname === "/drop") {
      for (const ws of this.ctx.getWebSockets()) ws.close(4003, "Removed");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/forward") {
      const ws = this.current();
      if (!ws) return offline();
      const path = req.headers.get("x-vireo-path") ?? "/";
      const events = path === "/api/events" || path.startsWith("/api/events?");
      const meter = await this.today();
      const limit = limitFor(meter.busyMs);
      if (events) {
        // Out of the day's allowance, or too soon after the last stream: make the app wait instead.
        const wait = limit.eventsMs === 0 ? untilUtcMidnight() : limit.gapMs - (Date.now() - meter.eventsEndedAt);
        if (wait > 0) return tooMany(wait);
      }
      const started = Date.now();
      const answer = await this.channel(ws).forward(req, path);
      // Only live updates can run long enough to matter; everything else is charged what it took to answer.
      if (!events) {
        this.ctx.waitUntil(this.spend(Date.now() - started));
        return answer;
      }
      return this.capped(answer, started, limit.eventsMs, () => void this.eventsEnded());
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    let frame: NodeToCloud;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as NodeToCloud;
    } catch {
      return;
    }
    if (frame.t === "ping") return ws.send(PONG);
    const { nodes } = await this.services();
    if (!att.authed) {
      if (frame.t !== "hello") return ws.close(4001, "Say hello first");
      if (!(await nodes.authenticate(att.nodeId, frame.nodeSecret))) return ws.close(4003, "Unknown node");
      for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(4000, "Replaced by a newer connection");
      ws.serializeAttachment({ ...att, authed: true } satisfies Attachment);
      ws.send(JSON.stringify({ t: "welcome", nodeId: att.nodeId } satisfies CloudToNode));
      return nodes.seen(att.nodeId, { version: frame.version, platform: frame.platform, mode: frame.mode, directUrl: frame.directUrl });
    }
    if (frame.t === "update") return nodes.seen(att.nodeId, { directUrl: frame.directUrl });
    this.channel(ws).receive(frame);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (this.bound?.ws === ws) {
      this.bound.channel.close("The node disconnected");
      this.bound = undefined;
    }
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    if (att?.authed) await (await this.services()).nodes.seen(att.nodeId, {});
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "Error");
  }
}
