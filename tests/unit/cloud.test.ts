import type { LinkStart, NodeAccess, NodeSummary } from "@vireo/protocol";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig as cloudConfig } from "../../apps/cloud/src/node/config.js";
import { runCloud, type RunningCloud } from "../../apps/cloud/src/node/server.js";
import { loadConfig as nodeConfig } from "../../apps/node/src/config.js";
import { runNode, type RunningNode } from "../../apps/node/src/server.js";
import { tempDir } from "./helpers.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface StartedCloud {
  base: string;
  stop(): Promise<void>;
}

/** The cloud as a Node server, in this process. */
async function nodeServer(): Promise<StartedCloud> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cloud: RunningCloud = await runCloud(cloudConfig({ VIREO_CLOUD_PORT: String(port), VIREO_CLOUD_HOST: "127.0.0.1", VIREO_CLOUD_URL: base, VIREO_CLOUD_DATA_DIR: tempDir(), VIREO_DEV_LOGIN: "1" }));
  return { base, stop: () => cloud.stop() };
}

/** The cloud as a Cloudflare Worker with D1 and Durable Objects, run locally by wrangler. */
async function worker(): Promise<StartedCloud> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const vars = { VIREO_CLOUD_URL: base, VIREO_WEB_URL: base, VIREO_DEV_LOGIN: "1" };
  const proc = spawn(
    resolve("node_modules/.bin/wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", tempDir(), "--show-interactive-dev-session=false", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    // Its own process group, so stopping it stops workerd too.
    { cwd: "apps/cloud", stdio: "ignore", detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok, () => false), 60_000);
  return {
    base,
    stop: async () => {
      process.kill(-proc.pid!, "SIGTERM");
    },
  };
}

describe.each([
  ["a Node server", nodeServer],
  ["a Cloudflare Worker", worker],
])("cloud on %s: linking and the relay", (_, launch) => {
  let cloud: StartedCloud;
  let node: RunningNode;
  let base = "";
  const json = async <T>(path: string, init: RequestInit & { token?: string; body?: string } = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  };
  const signIn = async (login: string) => (await json<{ token: string }>("/api/auth/dev", { method: "POST", body: JSON.stringify({ login }) })).body.token;
  let ana = "";
  let nodeId = "";

  beforeAll(async () => {
    cloud = await launch();
    base = cloud.base;
    ana = await signIn("ana");

    process.env.VIREO_SCHEDULER = "off";
    let code: LinkStart | undefined;
    node = await runNode(
      nodeConfig({ VIREO_DATA_DIR: tempDir(), VIREO_PORT: String(await freePort()), VIREO_CLOUD_URL: base, VIREO_NAME: "laptop", VIREO_FAKE_MODEL: "1", VIREO_FAKE_GOOGLE: "1" }),
      { onLinkCode: (s) => (code = s) },
    );
    const start = await until(() => code);
    expect(start.verifyUrl).toContain(`#link=${start.userCode}`);
    const request = await json<{ request: { name: string; mode: string } }>(`/api/link/${start.userCode}`, { token: ana });
    expect(request.body.request).toMatchObject({ name: "laptop", mode: "relay" });
    const approved = await json<{ node: NodeSummary }>(`/api/link/${start.userCode.toLowerCase().replace("-", " ")}/approve`, { method: "POST", token: ana, body: JSON.stringify({ name: "Ana's laptop" }) });
    nodeId = approved.body.node.id;
    await until(async () => (await json<{ nodes: NodeSummary[] }>("/api/nodes", { token: ana })).body.nodes.find((n) => n.online));
  }, 90_000);

  afterAll(async () => {
    await node?.stop();
    await cloud?.stop();
  });

  it("links the node to the account that approved it", async () => {
    expect(node.app.identity.get()).toMatchObject({ nodeId, owner: { login: "ana" }, mode: "relay" });
    const { body } = await json<{ nodes: NodeSummary[] }>("/api/nodes", { token: ana });
    expect(body.nodes).toEqual([expect.objectContaining({ id: nodeId, name: "Ana's laptop", online: true, mode: "relay" })]);
  });

  it("carries the owner's requests to the node, and only theirs", async () => {
    const access = (await json<NodeAccess>(`/api/nodes/${nodeId}/token`, { method: "POST", token: ana })).body;
    expect(access.baseUrl).toBe(`${base}/n/${nodeId}`);
    const threads = await fetch(`${access.baseUrl}/api/threads`, { headers: { authorization: `Bearer ${access.token}` } });
    expect(threads.status).toBe(200);
    expect(((await threads.json()) as { threads: unknown[] }).threads.length).toBeGreaterThan(0);

    expect((await fetch(`${access.baseUrl}/api/threads`)).status).toBe(401);
    const bob = await signIn("bob");
    expect((await json(`/api/nodes/${nodeId}/token`, { method: "POST", token: bob })).status).toBe(404);
    expect((await json<{ nodes: unknown[] }>("/api/nodes", { token: bob })).body.nodes).toEqual([]);
    // Public routes (OAuth callbacks, webhooks) pass through without a token and answer for themselves.
    expect((await fetch(`${access.baseUrl}/public/nothing-here`)).status).toBe(404);
  });

  it("streams live events and uploads through the relay", async () => {
    const access = (await json<NodeAccess>(`/api/nodes/${nodeId}/token`, { method: "POST", token: ana })).body;
    const abort = new AbortController();
    const events = await fetch(`${access.baseUrl}/api/events?access_token=${access.token}`, { signal: abort.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: ready");
    abort.abort();

    const created = await fetch(`${access.baseUrl}/api/threads`, { method: "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Files" }) });
    const thread = ((await created.json()) as { thread: { id: string } }).thread;
    const form = new FormData();
    form.append("file", new Blob([Buffer.alloc(300_000, 7)], { type: "application/octet-stream" }), "big.bin");
    const up = await fetch(`${access.baseUrl}/api/threads/${thread.id}/files`, { method: "POST", headers: { authorization: `Bearer ${access.token}` }, body: form });
    const file = ((await up.json()) as { files: { id: string; size: number }[] }).files[0]!;
    expect(file.size).toBe(300_000);
    const down = await fetch(`${access.baseUrl}/api/files/${file.id}?access_token=${access.token}`);
    expect(Buffer.from(await down.arrayBuffer()).equals(Buffer.alloc(300_000, 7))).toBe(true);
  });

  it("forgets the node once its owner removes it", async () => {
    expect((await json(`/api/nodes/${nodeId}`, { method: "DELETE", token: ana })).status).toBe(200);
    await until(() => !node.app.identity.get());
    expect((await json<{ nodes: unknown[] }>("/api/nodes", { token: ana })).body.nodes).toEqual([]);
  });
});
