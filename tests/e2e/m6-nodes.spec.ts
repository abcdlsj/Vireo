import { request as http } from "@playwright/test";
import { expect, linked, NODE, test } from "./helpers";

test.describe("Milestone 6 — Accounts and nodes", () => {
  test("[M6.1] a new node joins the account once its owner approves the code it shows", async ({ page, baseURL }) => {
    // A node that is not linked yet asks the cloud for a code, like `npx askvireo` does.
    const cloud = await http.newContext({ baseURL });
    const start = await (await cloud.post("/api/link/start", { data: { name: "Laptop", platform: "darwin arm64", version: "0.1.0", mode: "relay" } })).json();
    expect(start.userCode).toMatch(/^\w{4}-\w{4}$/);
    expect(start.verifyUrl).toContain(`#link=${start.userCode}`);
    expect((await (await cloud.post("/api/link/poll", { data: { deviceCode: start.deviceCode } })).json()).status).toBe("pending");

    await page.goto(`/#link=${start.userCode}`);
    await expect(page.getByTestId("link-request")).toContainText(start.userCode);
    await page.getByTestId("link-name").fill("Work laptop");
    await page.getByTestId("approve-node").click();
    await expect(page.getByText("Work laptop is now yours")).toBeVisible();

    // The node collects its identity once, then the code is spent.
    const done = await (await cloud.post("/api/link/poll", { data: { deviceCode: start.deviceCode } })).json();
    expect(done).toMatchObject({ status: "approved", owner: { login: "owner" }, publicKey: expect.stringContaining("PUBLIC KEY") });
    expect((await (await cloud.post("/api/link/poll", { data: { deviceCode: start.deviceCode } })).json()).status).toBe("expired");

    // Both nodes are listed; the new one is offline until it connects.
    await page.goto("/#settings/nodes");
    await expect(page.getByTestId("node-row")).toHaveCount(2);
    const row = page.getByTestId("node-row").filter({ hasText: "Work laptop" });
    await expect(row.locator(".dot.offline")).toBeVisible();
    await row.getByTestId("rename-node").click();
    await page.getByTestId("node-name-input").fill("Old laptop");
    await page.getByTestId("node-name-input").press("Enter");
    await expect(page.getByTestId("node-row").filter({ hasText: "Old laptop" })).toBeVisible();

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("node-row").filter({ hasText: "Old laptop" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("node-row")).toHaveCount(1);
    await expect(page.getByTestId("node-switch")).toContainText("Test node");
    await cloud.dispose();
  });

  test("[M6.2] another account cannot reach someone else's node", async ({ baseURL }) => {
    const cloud = await http.newContext({ baseURL });
    const { token } = await (await cloud.post("/api/auth/dev", { data: { login: "mallory" } })).json();
    const as = { authorization: `Bearer ${token}` };
    const { nodeId } = linked();
    expect((await (await cloud.get("/api/nodes", { headers: as })).json()).nodes).toEqual([]);
    expect((await cloud.post(`/api/nodes/${nodeId}/token`, { headers: as })).status()).toBe(404);
    expect((await cloud.get(`/n/${nodeId}/api/threads`, { headers: as })).status()).toBe(401);
    expect((await cloud.delete(`/api/nodes/${nodeId}`, { headers: as })).status()).toBe(404);
    await cloud.dispose();
  });

  test("[M6.3] the node serves no UI of its own", async () => {
    const anon = await http.newContext();
    expect(await (await anon.get(`${NODE}/`)).text()).toContain("is a Vireo node");
    expect(await (await anon.get(`${NODE}/api/health`)).json()).toMatchObject({ ok: true, linked: true });
    await anon.dispose();
  });

  test("[M6.4] a confirmation on another node is answered from this board", async ({ page }) => {
    // A second node, as the cloud lists it, answering through its own address.
    const other = "http://nas.test";
    let decided = "";
    await page.route("**/api/nodes", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.nodes.push({ id: "nas", name: "NAS", mode: "relay", online: true, directUrl: null, version: "0.1.2", platform: "linux x64", createdAt: Date.now(), lastSeenAt: Date.now() });
      await route.fulfill({ response: res, json: body });
    });
    await page.route("**/api/nodes/nas/token", (route) => route.fulfill({ json: { token: "t", expiresAt: Date.now() + 600_000, baseUrl: other, mode: "relay" } }));
    await page.route(`${other}/**`, async (route) => {
      const url = new URL(route.request().url());
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === "/api/threads") return route.fulfill({ headers: cors, json: { threads: [] } });
      if (url.pathname === "/api/actions") return route.fulfill({ headers: cors, json: { actions: decided ? [] : [{ id: "a1", threadId: "t1", tool: "agent_approval", args: {}, summary: "Delete old backups", status: "pending", result: null, display: null, createdAt: Date.now(), resolvedAt: null }] } });
      if (url.pathname === "/api/actions/a1/confirm") {
        decided = "confirm";
        return route.fulfill({ headers: cors, json: { action: { id: "a1", status: "done", result: "ok" } } });
      }
      return route.fulfill({ status: 404, headers: cors, json: {} });
    });

    await page.goto("/");
    const ask = page.getByTestId("other-ask");
    await expect(ask).toContainText("NAS asks");
    await expect(ask).toContainText("Delete old backups");
    // Each node in a faint colour of its own, the current one washing the sidebar.
    await expect(ask).toHaveClass(/node-tint/);
    await expect(page.locator("html")).toHaveClass(/many-nodes/);
    await ask.getByTestId("other-ask-confirm").click();
    await expect(ask).toContainText("Confirmed");
    expect(decided).toBe("confirm");
    // Still on this node.
    await expect(page.getByTestId("node-switch")).toContainText("Test node");
    await expect(page.getByTestId("other-ask")).toHaveCount(0);
  });
});
