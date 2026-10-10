/**
 * Frames on the relay socket between the cloud and a node. The cloud turns an
 * HTTP request for /n/:nodeId/... into a "request" frame; the node answers it
 * with its own HTTP handler and streams the response back, so server-sent
 * events and downloads pass through unchanged. Bodies are base64.
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
  body?: string;
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

/** Either side checks the other is still there; the answer is a pong. */
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

export type CloudToNode = RelayWelcome | RelayRequest | RelayCancel | RelayPing | RelayPong;
export type NodeToCloud = RelayHello | RelayUpdate | RelayResponseHead | RelayResponseChunk | RelayResponseEnd | RelayPing | RelayPong;
