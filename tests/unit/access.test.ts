import { describe, expect, it } from "vitest";
import { SigningKey } from "../../apps/cloud/src/keys.js";
import { verifyAccess } from "../../apps/node/src/access.js";
import { createHttp } from "../../apps/node/src/http/index.js";
import type { NodeIdentity } from "../../apps/node/src/identity.js";
import { tempDir, testApp } from "./helpers.js";

const owner = { id: "u_owner", login: "owner", name: "Owner", avatarUrl: null };

function setup() {
  const key = new SigningKey(tempDir());
  const identity: NodeIdentity = { nodeId: "n_1", cloudUrl: "http://cloud", nodeSecret: "s", owner, publicKey: key.publicPem, mode: "relay", linkedAt: 0 };
  const token = (over: Partial<{ sub: string; aud: string; exp: number }> = {}) =>
    key.sign({ iss: "http://cloud", sub: owner.id, aud: "n_1", login: "owner", role: "owner", iat: 0, exp: Math.floor(Date.now() / 1000) + 60, ...over });
  return { key, identity, token };
}

describe("node access tokens", () => {
  it("accept only the owner's token for this node, signed by its cloud and not expired", () => {
    const { identity, token } = setup();
    expect(verifyAccess(token(), identity)?.sub).toBe(owner.id);
    expect(verifyAccess(token({ aud: "n_other" }), identity)).toBeUndefined();
    expect(verifyAccess(token({ sub: "u_someone" }), identity)).toBeUndefined();
    expect(verifyAccess(token({ exp: Math.floor(Date.now() / 1000) - 1 }), identity)).toBeUndefined();
    const forged = setup().token();
    expect(verifyAccess(forged, identity)).toBeUndefined();
    expect(verifyAccess(`${token().slice(0, -4)}AAAA`, identity)).toBeUndefined();
    expect(verifyAccess(undefined, identity)).toBeUndefined();
  });

  it("guard the API, in a header or for URLs the browser loads itself", async () => {
    const { identity, token } = setup();
    const app = testApp();
    const http = createHttp(app);
    expect((await http.request("/api/threads")).status).toBe(503);
    app.identity.save(identity);
    expect((await http.request("/api/threads")).status).toBe(401);
    expect((await http.request("/api/threads", { headers: { authorization: `Bearer ${token({ sub: "u_x" })}` } })).status).toBe(401);
    expect((await http.request("/api/threads", { headers: { authorization: `Bearer ${token()}` } })).status).toBe(200);
    expect((await http.request(`/api/threads?access_token=${token()}`)).status).toBe(200);
    expect((await http.request("/api/health")).status).toBe(200);
  });
});
