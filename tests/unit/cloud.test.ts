import type { LinkStart, NodeAccess, NodeSummary } from "@vireo/protocol";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig as cloudConfig } from "../../apps/cloud/src/node/config.js";
import { runCloud, type RunningCloud } from "../../apps/cloud/src/node/server.js";
import { loadConfig as nodeConfig } from "../../apps/node/src/config.js";
import { MemorySync } from "../../apps/node/src/memory-sync.js";
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

  it("lets the owner's nodes work with each other, with nothing to set up", async () => {
    let code: LinkStart | undefined;
    const nas = await runNode(
      nodeConfig({ VIREO_DATA_DIR: tempDir(), VIREO_PORT: String(await freePort()), VIREO_CLOUD_URL: base, VIREO_NAME: "nas", VIREO_FAKE_MODEL: "1", VIREO_FAKE_GOOGLE: "1" }),
      { onLinkCode: (s) => (code = s) },
    );
    try {
      const start = await until(() => code);
      const nasId = (await json<{ node: NodeSummary }>(`/api/link/${start.userCode}/approve`, { method: "POST", token: ana, body: JSON.stringify({}) })).body.node.id;
      await until(async () => (await json<{ nodes: NodeSummary[] }>("/api/nodes", { token: ana })).body.nodes.find((n) => n.id === nasId && n.online));

      // Only a node of the account, with its own secret, learns about the others.
      expect((await json("/api/node/peers", { method: "POST", token: `${nodeId}:wrong` })).status).toBe(401);
      const peers = await node.app.peers.list(true);
      expect(peers).toEqual([expect.objectContaining({ id: nasId, name: "nas", url: `${base}/n/${nasId}/api/mcp` })]);
      // That token works for MCP on the other node, and only there.
      expect((await fetch(`${base}/n/${nodeId}/api/threads`, { headers: { authorization: `Bearer ${peers[0]!.token}` } })).status).toBe(401);

      const thread = node.app.threads.create({});
      const run = (tool: string, args: Record<string, unknown>) => node.app.tools.get(tool)!.run(args as never, { app: node.app, thread, agent: "remote", confirmed: true });
      expect(node.app.plugins.installed("nodes")).toBe(true);
      expect((await run("node_list", {})).text).toContain("## nas");

      // Something on the NAS waits on the owner; the laptop confirms it after the owner did, but only that one.
      const there = nas.app.threads.create({ temporary: true });
      const pending = nas.app.actions.create(there.id, "agent_approval", { from: "test" }, "Restart the backup job");
      expect((await run("node_confirm", { node: "nas", action_id: pending.id, summary: "Wipe the disks" })).failed).toBe(true);
      expect(nas.app.actions.get(pending.id)!.status).toBe("pending");
      expect((await run("node_confirm", { node: "nas", action_id: pending.id, summary: "Restart the backup job" })).text).toContain("Done");
      expect(nas.app.actions.get(pending.id)!.status).toBe("done");
      const other = nas.app.actions.create(there.id, "agent_approval", { from: "test" }, "Drop the table");
      await run("node_decline", { node: "nas", action_id: other.id });
      expect(nas.app.actions.get(other.id)!.status).toBe("cancelled");

      const asked = await run("node_ask", { node: "nas", task: "What's on my calendar today?", wait_seconds: 60 });
      expect(asked.text).toContain("thread_id:");
      const nasThread = nas.app.threads.list().find((t) => t.origin?.kind === "mcp" && !t.temporary)!;
      expect(JSON.stringify(nas.app.threads.messages(nasThread.id).find((m) => m.role === "user")!.body)).toContain("Vireo on laptop");
      // One memory: the first node (the laptop) is home; the NAS keeps a copy and sends home what it learns.
      expect(await nas.app.peers.home()).toMatchObject({ id: nodeId });
      expect(await node.app.peers.home()).toBeUndefined();
      node.app.memory.addFact({ entity: "Momo", entityKind: "pet", key: "species", statement: "Momo is the owner's dog" });
      nas.app.memory.addFact({ key: "drink", statement: "The owner prefers tea" });
      const sync = new MemorySync(nas.app);
      await sync.sync();
      const statements = (app: typeof node.app) => app.memory.list().map((f) => f.statement).sort();
      expect(statements(nas.app)).toEqual(expect.arrayContaining(["Momo is the owner's dog", "The owner prefers tea"]));
      expect(statements(node.app)).toEqual(statements(nas.app));
      // What the owner takes back on the NAS is gone at home too.
      nas.app.memory.delete(nas.app.memory.list().find((f) => f.statement.startsWith("Momo"))!.id);
      await sync.sync();
      expect(statements(node.app)).not.toContain("Momo is the owner's dog");
      expect(statements(nas.app)).toEqual(statements(node.app));
      sync.stop();

      expect((await json(`/api/nodes/${nasId}`, { method: "DELETE", token: ana })).status).toBe(200);
    } finally {
      await nas.stop();
    }
  }, 60_000);

  it("walks the owner through putting a Tailscale node on the tailnet", async () => {
    const gate = join(tempDir(), "https-allowed");
    process.env.FAKE_TS_SERVE_GATE = gate;
    let code: LinkStart | undefined;
    const box = await runNode(
      nodeConfig({ VIREO_DATA_DIR: tempDir(), VIREO_PORT: String(await freePort()), VIREO_CLOUD_URL: base, VIREO_NAME: "box", VIREO_MODE: "tailscale", VIREO_FAKE_MODEL: "1", VIREO_FAKE_GOOGLE: "1" }),
      { onLinkCode: (s) => (code = s), tailscale: { mode: "system", bin_dir: resolve("tests/fixtures/fake-tailscale") } },
    );
    try {
      const start = await until(() => code);
      const boxId = (await json<{ node: NodeSummary }>(`/api/link/${start.userCode}/approve`, { method: "POST", token: ana, body: JSON.stringify({}) })).body.node.id;
      const box_ = async () => (await json<{ nodes: NodeSummary[] }>("/api/nodes", { token: ana })).body.nodes.find((n) => n.id === boxId);
      // HTTPS isn't allowed on the tailnet yet: the app learns the step and the link.
      const waiting = await until(async () => ((await box_())?.setup?.step === "https" ? box_() : undefined));
      expect(waiting).toMatchObject({ mode: "tailscale", directUrl: null, setup: { step: "https", link: "https://login.tailscale.com/f/serve?node=n0" } });
      writeFileSync(gate, "");
      const ready = await until(async () => ((await box_())?.directUrl ? box_() : undefined));
      expect(ready).toMatchObject({ directUrl: "https://vireo.tail-test.ts.net", setup: null });
      await json(`/api/nodes/${boxId}`, { method: "DELETE", token: ana });
    } finally {
      delete process.env.FAKE_TS_SERVE_GATE;
      await box.stop();
    }
  }, 60_000);

  it("forgets the node once its owner removes it", async () => {
    expect((await json(`/api/nodes/${nodeId}`, { method: "DELETE", token: ana })).status).toBe(200);
    await until(() => !node.app.identity.get());
    expect((await json<{ nodes: unknown[] }>("/api/nodes", { token: ana })).body.nodes).toEqual([]);
  });
});
