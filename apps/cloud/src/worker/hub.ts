import type { NodeHub } from "../core/hub.js";

/** Nodes' relay sockets on Cloudflare: one Durable Object per node (see relay.ts). */
export class DurableHub implements NodeHub {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(nodeId: string): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(nodeId));
  }

  async online(nodeId: string): Promise<boolean> {
    const res = await this.stub(nodeId).fetch("https://relay/online");
    return ((await res.json()) as { online: boolean }).online;
  }

  async forward(nodeId: string, req: Request, path: string): Promise<Response> {
    const inner = new Request("https://relay/forward", req);
    inner.headers.set("x-vireo-path", path);
    return this.stub(nodeId).fetch(inner);
  }

  async drop(nodeId: string): Promise<void> {
    await this.stub(nodeId).fetch("https://relay/drop", { method: "POST" });
  }
}
