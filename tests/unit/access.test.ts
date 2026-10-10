import { describe, expect, it } from "vitest";
import { migrate } from "../../apps/cloud/src/core/cloud.js";
import { SigningKey } from "../../apps/cloud/src/core/keys.js";
import { FileDb } from "../../apps/cloud/src/node/db.js";
import { verifyAccess } from "../../apps/node/src/access.js";
import { createHttp } from "../../apps/node/src/http/index.js";
import type { NodeIdentity } from "../../apps/node/src/identity.js";
import { tempDir, testApp } from "./helpers.js";

const owner = { id: "u_owner", login: "owner", name: "Owner", avatarUrl: null };

/** A cloud key (WebCrypto, as on Cloudflare) whose tokens the node checks with node:crypto. */
async function setup() {
  const db = new FileDb(tempDir());
  await migrate(db);
  const key = await SigningKey.load(db);
  const identity: NodeIdentity = { nodeId: "n_1", cloudUrl: "http://cloud", nodeSecret: "s", owner, publicKey: key.publicPem, mode: "relay", linkedAt: 0 };
  const token = (over: Partial<{ sub: string; aud: string; exp: number }> = {}) =>
    key.sign({ iss: "http://cloud", sub: owner.id, aud: "n_1", login: "owner", role: "owner", iat: 0, exp: Math.floor(Date.now() / 1000) + 60, ...over });
  return { key, identity, token };
}

describe("node access tokens", () => {
  it("accept only the owner's token for this node, signed by its cloud and not expired", async () => {
    const { identity, token, key } = await setup();
    expect(verifyAccess(await token(), identity)?.sub).toBe(owner.id);
    expect((await key.verify(await token()))?.sub).toBe(owner.id);
    expect(verifyAccess(await token({ aud: "n_other" }), identity)).toBeUndefined();
    expect(verifyAccess(await token({ sub: "u_someone" }), identity)).toBeUndefined();
    expect(verifyAccess(await token({ exp: Math.floor(Date.now() / 1000) - 1 }), identity)).toBeUndefined();
    const forged = await (await setup()).token();
    expect(verifyAccess(forged, identity)).toBeUndefined();
    expect(await key.verify(forged)).toBeUndefined();
    expect(verifyAccess(`${(await token()).slice(0, -4)}AAAA`, identity)).toBeUndefined();
    expect(verifyAccess(undefined, identity)).toBeUndefined();
  });

  it("guard the API, in a header or for URLs the browser loads itself", async () => {
    const { identity, token } = await setup();
    const app = testApp();
    const http = createHttp(app);
    expect((await http.request("/api/threads")).status).toBe(503);
    app.identity.save(identity);
    expect((await http.request("/api/threads")).status).toBe(401);
    expect((await http.request("/api/threads", { headers: { authorization: `Bearer ${await token({ sub: "u_x" })}` } })).status).toBe(401);
    expect((await http.request("/api/threads", { headers: { authorization: `Bearer ${await token()}` } })).status).toBe(200);
    expect((await http.request(`/api/threads?access_token=${await token()}`)).status).toBe(200);
    expect((await http.request("/api/health")).status).toBe(200);
  });
});
