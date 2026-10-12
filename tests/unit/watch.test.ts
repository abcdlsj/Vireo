import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import type { Peer } from "../../apps/node/src/peers.js";
import { newer, PeerWatch } from "../../apps/node/src/watch.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(() => {
  for (const app of apps) app.db.close();
  apps = [];
});

describe("watching the owner's nodes", () => {
  it("tells the home node's owner once when a node stays offline, and when it is back", async () => {
    const app = testApp();
    apps.push(app);
    const nas: Peer = { id: "n_nas", name: "nas", online: false, platform: "linux", url: "", token: "", expiresAt: 0, createdAt: 2 };
    app.peers.list = async () => [nas];
    app.peers.home = async () => undefined;
    const watch = new PeerWatch(app);
    const t = Date.now();
    await watch.check(t);
    await watch.check(t + 10 * 60_000);
    expect(app.push.recent.filter((n) => n.title.includes("nas"))).toHaveLength(0);
    await watch.check(t + 31 * 60_000);
    await watch.check(t + 40 * 60_000);
    expect(app.push.recent.filter((n) => n.title === "nas is offline")).toHaveLength(1);
    nas.online = true;
    await watch.check(t + 45 * 60_000);
    expect(app.push.recent[0]!.title).toBe("nas is back");
  });

  it("stays quiet on a node that is not home", async () => {
    const app = testApp();
    apps.push(app);
    const home: Peer = { id: "n_home", name: "home", online: false, platform: null, url: "", token: "", expiresAt: 0, createdAt: 1 };
    app.peers.list = async () => [home];
    app.peers.home = async () => home;
    const watch = new PeerWatch(app);
    await watch.check(0);
    await watch.check(60 * 60_000);
    expect(app.push.recent).toHaveLength(0);
  });

  it("compares versions", () => {
    expect(newer("0.1.10", "0.1.9")).toBe(true);
    expect(newer("0.2.0", "0.1.9")).toBe(true);
    expect(newer("0.1.2", "0.1.2")).toBe(false);
    expect(newer("0.1.1", "0.1.2")).toBe(false);
  });
});
