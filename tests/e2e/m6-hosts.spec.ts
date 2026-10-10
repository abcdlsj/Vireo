import { expect, test } from "@playwright/test";

/** The test host, reached directly (another origin than the app), as a remote host would be. */
const HOST = "http://127.0.0.1:8798";

test.describe("Milestone 6 — Hosts", () => {
  test("[M6.1] the app pairs with a remote host by code and switches between hosts", async ({ page, request }) => {
    // A paired device hands out a code for the next one.
    const { code, name } = await (await request.post("/api/pairing")).json();
    expect(code).toMatch(/^\w{4}-\w{4}$/);

    await page.goto("/#thread/overview");
    await page.getByTestId("host-switch").click();
    await page.getByTestId("add-host").click();
    await page.getByTestId("host-address").fill(`${HOST}#pair=${code.replace("-", "")}`);
    await page.getByTestId("pair-host").click();

    // The app now talks to the host cross-origin with its paired token.
    await expect(page.getByTestId("host-switch")).toContainText(name);
    await expect(page.getByTestId("home")).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("vireo.hosts") ?? "[]"));
    expect(stored).toEqual([expect.objectContaining({ url: HOST, token: expect.any(String) })]);

    // The code was single use.
    const again = await request.post(`${HOST}/api/auth/pair`, { data: { code } });
    expect(again.status()).toBe(401);

    await page.goto("/#settings/hosts");
    await expect(page.getByTestId("host-row")).toHaveCount(2);
    await page.getByTestId("host-switch").click();
    await page.getByRole("menuitemradio", { name: /This machine/ }).click();
    await expect(page.getByTestId("host-switch")).toContainText("This machine");
  });

  test("[M6.3] this machine can be renamed, and back", async ({ page }) => {
    await page.goto("/#settings/hosts");
    const row = page.getByTestId("host-row").filter({ hasText: "This machine" });
    await row.getByTestId("rename-host").click();
    await page.getByTestId("host-name-input").fill("Studio Mac");
    await page.getByTestId("host-name-input").press("Enter");
    await expect(page.getByTestId("host-row").first()).toContainText("Studio Mac");
    await expect(page.getByTestId("host-switch")).toContainText("Studio Mac");

    // Clearing the name puts the default back.
    await page.getByTestId("host-row").first().getByTestId("rename-host").click();
    await page.getByTestId("host-name-input").fill("");
    await page.getByTestId("host-name-input").press("Enter");
    await expect(page.getByTestId("host-switch")).toContainText("This machine");
  });

  test("[M6.2] the host serves no UI of its own", async ({ request }) => {
    const res = await request.get(`${HOST}/`);
    expect(await res.text()).toContain("is a Vireo host");
  });
});
