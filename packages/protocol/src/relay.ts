/**
 * Frames on the relay socket between the cloud and a node. The node opens the
 * socket at /api/nodes/:nodeId/connect and says hello with its secret. The
 * cloud turns an HTTP request for /n/:nodeId/... into a "req" frame (its body
 * follows in "body" frames); the node answers it with its own HTTP handler
 * and streams the response back, so server-sent events and downloads pass
 * through unchanged. Bodies are base64, in pieces small enough for any
 * socket (Cloudflare caps a message at 1 MiB).
 */

/** The node's first frame after the socket opens. */
export interface RelayHello {
  t: "hello";
  nodeSecret: string;
  version: string;
  platform: string;
  mode: "relay" | "tailscale";
  directUrl: string | null;
}

/** The node reports a change (e.g. its tailnet address became known). */
export interface RelayUpdate {
  t: "update";
  directUrl: string | null;
}

export interface RelayRequest {
  t: "req";
  id: number;
  method: string;
  /** Path and query on the node, e.g. "/api/threads?x=1". */
  path: string;
  headers: Record<string, string>;
  /** A body follows in "body" frames, the last one with `end`. */
  hasBody: boolean;
}

export interface RelayRequestBody {
  t: "body";
  id: number;
  data?: string;
  end?: true;
}

/** The cloud no longer wants a response (the browser went away). */
export interface RelayCancel {
  t: "cancel";
  id: number;
}

export interface RelayResponseHead {
  t: "head";
  id: number;
  status: number;
  headers: Record<string, string>;
}

export interface RelayResponseChunk {
  t: "chunk";
  id: number;
  data: string;
}

export interface RelayResponseEnd {
  t: "end";
  id: number;
  error?: string;
}

/**
 * The node checks the socket is alive, sent exactly as `{"t":"ping"}` so the
 * cloud can answer without waking up; the answer is exactly `{"t":"pong"}`.
 */
export interface RelayPing {
  t: "ping";
}

export interface RelayPong {
  t: "pong";
}

export interface RelayWelcome {
  t: "welcome";
  nodeId: string;
}

export type CloudToNode = RelayWelcome | RelayRequest | RelayRequestBody | RelayCancel | RelayPong;
export type NodeToCloud = RelayHello | RelayUpdate | RelayResponseHead | RelayResponseChunk | RelayResponseEnd | RelayPing;
