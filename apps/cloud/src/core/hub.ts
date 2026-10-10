/**
 * Where nodes' relay sockets live: in the Node server's memory, or one
 * Durable Object per node on Cloudflare.
 */
export interface NodeHub {
  online(nodeId: string): Promise<boolean>;
  /** Carries an app request to the node; 503 when it is offline. */
  forward(nodeId: string, req: Request, path: string): Promise<Response>;
  /** Disconnects a node removed from its account. */
  drop(nodeId: string): Promise<void>;
}

export const offline = () => Response.json({ error: "This node is offline. Start it with `npx vireo-node`." }, { status: 503 });
