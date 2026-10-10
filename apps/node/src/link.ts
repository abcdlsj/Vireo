import type { LinkPoll, LinkStart, LinkStartRequest } from "@vireo/protocol";
import type { NodeIdentity } from "./identity.js";

async function post<T>(cloudUrl: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${cloudUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${cloudUrl} answered ${res.status}`);
  return data;
}

/**
 * Links this node to its owner's account, like signing a TV in to a
 * streaming service: the node gets a code, the owner opens the link (signed
 * in with GitHub) and approves it, and the node collects its identity. A code
 * that expires unused is replaced by a fresh one.
 */
export async function linkNode(opts: {
  cloudUrl: string;
  request: LinkStartRequest;
  /** Show the owner where to approve this node. */
  onCode: (start: LinkStart) => void;
  signal?: AbortSignal;
}): Promise<NodeIdentity> {
  const { cloudUrl, signal } = opts;
  for (;;) {
    const start = await post<LinkStart>(cloudUrl, "/api/link/start", opts.request, signal);
    opts.onCode(start);
    for (;;) {
      await new Promise((r) => setTimeout(r, start.interval * 1000));
      signal?.throwIfAborted();
      const poll = await post<LinkPoll>(cloudUrl, "/api/link/poll", { deviceCode: start.deviceCode }, signal).catch((): LinkPoll => ({ status: "pending" }));
      if (poll.status === "pending") continue;
      if (poll.status === "denied") throw new Error("The link was declined in the app.");
      if (poll.status === "expired") break;
      return { nodeId: poll.nodeId, cloudUrl, nodeSecret: poll.nodeSecret, owner: poll.owner, publicKey: poll.publicKey, mode: opts.request.mode, linkedAt: Date.now() };
    }
  }
}
