import { request, type FullConfig } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const OWNER = "owner";
const NODE = "http://127.0.0.1:8798";

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Signs the owner in, links the test node to the account with the code it
 * printed (as the owner would in the app), and saves a signed-in browser for
 * the tests plus a token for calling the node's API.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;
  mkdirSync(".vireo-test", { recursive: true });
  const cloud = await request.newContext({ baseURL });
  const { token: session } = await (await cloud.post("/api/auth/dev", { data: { login: OWNER } })).json();
  const auth = { authorization: `Bearer ${session}` };

  const code = await until("the node's link code", async () => {
    const log = existsSync(".vireo-test/server.log") ? readFileSync(".vireo-test/server.log", "utf8") : "";
    return [...log.matchAll(/code is (\w{4}-\w{4})/g)].at(-1)?.[1];
  });
  const approved = await cloud.post(`/api/link/${code}/approve`, { headers: auth, data: {} });
  if (!approved.ok()) throw new Error(`approve failed: ${approved.status()} ${await approved.text()}`);
  const { node } = await approved.json();
  await until("the node to come online", async () => {
    const { nodes } = await (await cloud.get("/api/nodes", { headers: auth })).json();
    return nodes.some((n: { id: string; online: boolean }) => n.id === node.id && n.online) || undefined;
  });
  const access = await (await cloud.post(`/api/nodes/${node.id}/token`, { headers: auth })).json();
  await cloud.dispose();

  // The node keeps the owner's time zone, as the app would set it.
  const api = await request.newContext({ baseURL: NODE, extraHTTPHeaders: { authorization: `Bearer ${access.token}` } });
  await api.patch("/api/settings", { data: { timezone: "Asia/Shanghai" } });
  await api.dispose();

  writeFileSync(".vireo-test/node.json", JSON.stringify({ nodeId: node.id, token: access.token, session }));
  writeFileSync(
    ".vireo-test/owner.json",
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL).origin,
          localStorage: [
            { name: "vireo.session", value: session },
            { name: "vireo.node", value: node.id },
          ],
        },
      ],
    }),
  );
}
