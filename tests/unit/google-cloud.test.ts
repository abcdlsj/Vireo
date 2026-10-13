import type { LinkStart, NodeSummary } from "@vireo/protocol";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig as cloudConfig } from "../../apps/cloud/src/node/config.js";
import { runCloud, type RunningCloud } from "../../apps/cloud/src/node/server.js";
import { loadConfig as nodeConfig } from "../../apps/node/src/config.js";
import { GoogleAuth } from "../../apps/node/src/plugins/google/api.js";
import { runNode, type RunningNode } from "../../apps/node/src/server.js";
import { tempDir } from "./helpers.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
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

const CLIENT_ID = "1234567890-shared.apps.googleusercontent.com";
// Made up, and assembled so secret scanners do not take it for a real one.
const CLIENT_SECRET = ["GOCSPX", "shared".repeat(4)].join("-");

describe("Google on Vireo's shared client", () => {
  let cloud: RunningCloud;
  let node: RunningNode;
  let google: Server;
  let base = "";
  let nodeId = "";
  /** What Google's token endpoint was asked. */
  const asked: URLSearchParams[] = [];

  beforeAll(async () => {
    google = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const p = new URLSearchParams(body);
        asked.push(p);
        res.setHeader("content-type", "application/json");
        if (p.get("client_secret") !== CLIENT_SECRET) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: "invalid_client" }));
        }
        const idToken = `x.${Buffer.from(JSON.stringify({ email: "ana@example.com" })).toString("base64url")}.y`;
        res.end(
          JSON.stringify(
            p.get("grant_type") === "authorization_code"
              ? { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, id_token: idToken, scope: "openid email https://www.googleapis.com/auth/drive.readonly" }
              : { access_token: "at-2", expires_in: 3600 },
          ),
        );
      });
    });
    const googlePort = await listen(google);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cloud = await runCloud(
      cloudConfig({
        VIREO_CLOUD_PORT: String(port),
        VIREO_CLOUD_HOST: "127.0.0.1",
        VIREO_CLOUD_URL: base,
        VIREO_CLOUD_DATA_DIR: tempDir(),
        VIREO_DEV_LOGIN: "1",
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        VIREO_GOOGLE_TOKEN_URL: `http://127.0.0.1:${googlePort}/token`,
      }),
    );
    const token = ((await (await fetch(`${base}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "ana" }) })).json()) as { token: string }).token;

    process.env.VIREO_SCHEDULER = "off";
    let code: LinkStart | undefined;
    node = await runNode(nodeConfig({ VIREO_DATA_DIR: tempDir(), VIREO_PORT: String(await freePort()), VIREO_CLOUD_URL: base, VIREO_NAME: "laptop", VIREO_FAKE_MODEL: "1" }), {
      onLinkCode: (s) => (code = s),
    });
    const start = await until(() => code);
    const approved = await fetch(`${base}/api/link/${start.userCode}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    nodeId = ((await approved.json()) as { node: NodeSummary }).node.id;
    await until(() => node.app.identity.get());
  }, 30_000);

  afterAll(async () => {
    await node?.stop();
    await cloud?.stop();
    google?.close();
  });

  it("connects with a click: no client to create, the cloud trades the code", async () => {
    const { app } = node;
    await app.plugins.install("google");
    const st = await app.plugins.statusOf("google");
    expect(st).toMatchObject({ state: "login", details: [] });

    const auth = new URL((await app.plugins.action("google", "connect", { origin: "http://127.0.0.1", appOrigin: "https://app.example.com" })).redirect!);
    expect(auth.origin).toBe("https://accounts.google.com");
    expect(auth.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${base}/oauth/google/callback`);
    const state = auth.searchParams.get("state")!;

    // Google sends the browser to the cloud, and the cloud on to the node, through the relay.
    expect((await fetch(`${base}/oauth/google/callback?state=wrong&code=c`, { redirect: "manual" })).status).toBe(400);
    const toNode = await fetch(`${base}/oauth/google/callback?state=${state}&code=google-code`, { redirect: "manual" });
    const nodeCallback = new URL(toNode.headers.get("location")!);
    expect(nodeCallback.pathname).toBe(`/n/${nodeId}/public/google/callback`);
    const back = await fetch(nodeCallback, { redirect: "manual" });
    expect(back.headers.get("location")).toBe("https://app.example.com/#settings/plugins?google=connected");

    expect(asked.at(-1)).toMatchObject(new URLSearchParams({ grant_type: "authorization_code", code: "google-code", redirect_uri: `${base}/oauth/google/callback`, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }));
    expect((await app.plugins.statusOf("google"))?.message).toBe("Connected as ana@example.com.");
    // The cloud keeps nothing it could redeem twice.
    const id = app.identity.get()!;
    const again = await fetch(`${base}/api/node/google/token`, { method: "POST", headers: { authorization: `Bearer ${id.nodeId}:${id.nodeSecret}`, "content-type": "application/json" }, body: JSON.stringify({ state, code: "google-code" }) });
    expect(again.status).toBe(400);
  });

  it("refreshes through the cloud, and only for a linked node", async () => {
    const id = node.app.identity.get()!;
    const tokens = new Map<string, unknown>([["tokens", { access_token: "old", refresh_token: "rt-1", expires_at: 0, shared: true }]]);
    const state = { get: <T>(k: string) => tokens.get(k) as T, set: (k: string, v: unknown) => void tokens.set(k, v), delete: (k: string) => void tokens.delete(k) };
    const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${id.nodeId}:${id.nodeSecret}`, "content-type": "application/json" } });
    expect(await new GoogleAuth(state, () => undefined, call).accessToken()).toBe("at-2");
    expect(asked.at(-1)?.get("grant_type")).toBe("refresh_token");

    const stranger = await fetch(`${base}/api/node/google/refresh`, { method: "POST", headers: { authorization: `Bearer ${id.nodeId}:wrong`, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: "rt-1" }) });
    expect(stranger.status).toBe(401);
  });
});
