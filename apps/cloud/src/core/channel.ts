import type { CloudToNode, NodeToCloud } from "@vireo/protocol";
import { fromBase64Url, toBase64Url } from "./util.js";

/** Largest request body the relay carries (file uploads). */
const MAX_BODY = 25 * 1024 * 1024;
/** Request bodies go to the node in pieces this size (well under 1 MiB once base64). */
const BODY_CHUNK = 256 * 1024;
/** How long a node has to start answering a request. */
const HEAD_TIMEOUT = 120_000;
/** Headers that describe one hop, not the request; never forwarded. */
const HOP = new Set(["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "content-length", "te", "trailer", "proxy-authorization", "cookie", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "x-real-ip"]);

interface Pending {
  head: (res: Response) => void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });

/**
 * The app's requests to one connected node, over its socket: each request
 * goes out as frames and its response comes back as a stream. The same
 * logic runs in the Node server and in a Cloudflare Durable Object; only how
 * frames are sent differs.
 */
export class Channel {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly send: (frame: CloudToNode) => void) {}

  async forward(req: Request, path: string): Promise<Response> {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
    if (body && body.length > MAX_BODY) return error(413, "That is larger than 25 MB.");
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!HOP.has(k)) headers[k] = v;
    });
    const id = this.nextId++;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ t: "cancel", id });
        resolve(error(504, "The node took too long to answer"));
      }, HEAD_TIMEOUT);
      this.pending.set(id, { head: resolve, timer });
      this.send({ t: "req", id, method: req.method, path, headers, hasBody: Boolean(body?.length) });
      if (body?.length) {
        for (let i = 0; i < body.length; i += BODY_CHUNK) this.send({ t: "body", id, data: toBase64Url(body.subarray(i, i + BODY_CHUNK)) });
        this.send({ t: "body", id, end: true });
      }
    });
  }

  /** A frame from the node about one of the requests. */
  receive(frame: NodeToCloud): void {
    if (frame.t !== "head" && frame.t !== "chunk" && frame.t !== "end") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    if (frame.t === "head") {
      clearTimeout(p.timer);
      const id = frame.id;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          p.stream = c;
        },
        // The browser went away: tell the node to stop.
        cancel: () => {
          this.pending.delete(id);
          this.send({ t: "cancel", id });
        },
      });
      const nullBody = [101, 204, 205, 304].includes(frame.status);
      p.head(new Response(nullBody ? null : body, { status: frame.status, headers: frame.headers }));
    } else if (frame.t === "chunk") {
      p.stream?.enqueue(fromBase64Url(frame.data));
    } else {
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error && !p.stream) p.head(error(502, frame.error));
      try {
        if (frame.error) p.stream?.error(new Error(frame.error));
        else p.stream?.close();
      } catch {
        // already cancelled by the browser
      }
    }
  }

  /** The socket closed: everything in flight fails. */
  close(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (!p.stream) p.head(error(502, reason));
      try {
        p.stream?.error(new Error(reason));
      } catch {
        // already closed
      }
    }
    this.pending.clear();
  }
}
