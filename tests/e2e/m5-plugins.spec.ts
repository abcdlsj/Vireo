import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { finalReply, startThread } from "./helpers";

const FAKE_TS = resolve("tests/fixtures/fake-tailscale");

test.describe("Milestone 5 — Plugins", () => {
  test("[M5.1] a community plugin is added from Settings and configured there", async ({ page }) => {
    await page.goto("/#settings/plugins");
    const card = page.getByTestId("plugins-card");
    await card.getByTestId("community-plugins").click();
    await expect(page.getByTestId("plugin-catalog")).toContainText("Tailscale");
    await page.getByTestId("add-plugin-tailscale").click();
    const ts = page.getByTestId("plugin-tailscale");
    await expect(ts).toBeVisible();
    await ts.getByRole("button", { name: "Settings" }).click();
    await ts.getByLabel("Connection").selectOption("system");
    await ts.getByLabel("Tailscale binaries directory").fill(FAKE_TS);
    await ts.getByLabel("API access token").fill("tskey-api-e2e-secret");
    await ts.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("plugin-tailscale-status")).toContainText("Connected to owner@example.com as vireo");
    // The token is stored but never sent back to the browser.
    await page.reload();
    const body = await (await page.request.get("/api/plugins")).text();
    expect(body).not.toContain("tskey-api-e2e-secret");
  });

  test("[M5.2] Tailscale reaches the owner's other machines on the tailnet", async ({ page, request }) => {
    await startThread(page, "Which of my tailnet machines are online?");
    expect(await finalReply(page, request)).toContain("Online: nas. Offline: old-laptop.");
    await startThread(page, "Run `uptime` on nas over ssh");
    await expect(page.getByTestId("action-card")).toContainText("Run on nas: uptime");
  });

  test("[M5.3] Google is a plugin and brings Drive", async ({ page, request }) => {
    await page.goto("/#settings/plugins");
    await page.getByTestId("community-plugins").click();
    await page.getByTestId("add-plugin-google").click();
    await expect(page.getByTestId("plugin-google-status")).toContainText("Demo mode");
    await startThread(page, "In my drive, find the Lisbon trip plan");
    expect(await finalReply(page, request)).toContain("LX-4821");
  });
});
