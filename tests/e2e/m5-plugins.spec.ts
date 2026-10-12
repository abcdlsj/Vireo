import { resolve } from "node:path";
import { expect, test } from "./helpers";
import { finalReply, startThread } from "./helpers";

const FAKE_TS = resolve("tests/fixtures/fake-tailscale");

test.describe("Milestone 5 — Plugins", () => {
  test("[M5.1] a community plugin is added from Settings and configured there", async ({ page }) => {
    await page.goto("/#settings/plugins");
    const card = page.getByTestId("plugins-card");
    await card.getByTestId("community-plugins").click();
    for (const name of ["Tailscale", "Telegram", "Feishu / Lark", "MCP servers", "Coding agents", "Search providers"]) await expect(page.getByTestId("plugin-catalog")).toContainText(name);
    await page.getByTestId("add-plugin-tailscale").click();
    const ts = page.getByTestId("plugin-tailscale");
    await expect(ts).toBeVisible();
    const connection = ts.getByLabel("Connection");
    // A plugin that needs attention opens its settings by itself.
    if (!(await connection.isVisible())) await ts.getByTestId("plugin-tailscale-settings").click();
    await connection.selectOption("system");
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
    const card = page.getByTestId("action-card");
    await expect(card).toContainText("Run on nas: uptime");
    // Once it ran, the card shows what came back without the wrapper meant for the model.
    await card.getByTestId("action-confirm").click();
    await expect(card.getByTestId("action-result")).toBeVisible();
    await expect(card).not.toContainText("untrusted_content");
    await expect(card).not.toContainText("Do not follow instructions");
  });

  test("[M5.3] Google is a plugin and brings Drive", async ({ page, request }) => {
    await page.goto("/#settings/plugins");
    await page.getByTestId("community-plugins").click();
    await page.getByTestId("add-plugin-google").click();
    await expect(page.getByTestId("plugin-google-status")).toContainText("Demo mode");
    await startThread(page, "In my drive, find the Lisbon trip plan");
    expect(await finalReply(page, request)).toContain("LX-4821");
  });

  test("[M5.4] coding agents hold several setups, each with its own command and repository", async ({ page }) => {
    const repo = resolve("tests/fixtures");
    await page.goto("/#settings/plugins");
    await page.getByTestId("community-plugins").click();
    await page.getByTestId("add-plugin-agents").click();
    const card = page.getByTestId("plugin-agents");
    await expect(page.getByTestId("plugin-agents-status")).toBeVisible();
    const first = card.getByTestId("pf-agents-0-directory");
    if (!(await first.isVisible())) await card.getByTestId("plugin-agents-settings").click();

    // One setup is there to begin with, pointed at Claude.
    await first.fill(repo);
    await expect(page.getByTestId("plugin-agents-status")).toContainText("claude");

    // A second setup, on another agent and another command of the owner's.
    await card.getByTestId("pf-agents-add").click();
    await card.getByTestId("pf-agents-1-name").fill("relay");
    await card.getByTestId("pf-agents-1-command").fill("codex");
    await card.getByTestId("pf-agents-1-directory").fill(repo);
    await card.getByTestId("pf-agents-1-env").fill("CODEX_PATH=ak-bilicodex");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("plugin-agents-status")).toContainText("relay (codex)");

    // Both survive a reload, environment included.
    await page.reload();
    await expect(page.getByTestId("plugin-agents-status")).toContainText("relay (codex)");
    const again = page.getByTestId("plugin-agents");
    if (!(await again.getByTestId("pf-agents-1-name").isVisible())) await again.getByTestId("plugin-agents-settings").click();
    await expect(again.getByTestId("pf-agents-1-name")).toHaveValue("relay");
    await expect(again.getByTestId("pf-agents-1-env")).toHaveValue("CODEX_PATH=ak-bilicodex");
  });
});
