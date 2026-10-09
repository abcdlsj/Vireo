import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { finalReply, FIXTURES, sendMessage, settle, startThread, threadDetail } from "./helpers";

const SITE_PASSWORD = "s3cret-Pa55word!";

test.describe("Milestone 4 — Proactive and hands-on", () => {
  test("[M4.1] the morning brief arrives in Overview with schedule, pending replies and open threads", async ({ page, request }) => {
    await page.goto("/#thread/overview");
    const before = await page.getByTestId("msg-assistant").count();
    await page.getByTestId("brief-now").click();
    await expect(page.getByTestId("msg-assistant")).toHaveCount(before + 1);
    const brief = page.getByTestId("msg-assistant").last();
    await expect(brief).toContainText("Today's schedule");
    await expect(brief).toContainText("Emails awaiting a reply");
    await expect(brief).toContainText("Lunch on Friday"); // the email thread from M3.2
    await expect(brief).toContainText("Open threads");
    // Links in the brief open the threads.
    await brief.locator("a[href^='#thread/']").first().click();
    await expect(page.getByTestId("thread-view")).not.toHaveAttribute("data-thread-id", "overview");
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications;
    expect(notes.some((n: { title: string }) => n.title === "Your morning brief")).toBeTruthy();
  });

  test("[M4.2] a multi-step website task completes, pausing for confirmation before submitting", async ({ page, request }) => {
    await request.get(`${FIXTURES}/_reset`);
    await request.post("/api/credentials", { data: { domain: "localhost", username: "lisa", password: SITE_PASSWORD } });
    const id = await startThread(page, `Book a table for 2 people at ${FIXTURES}/login under the name Lisa`);
    const card = page.getByTestId("action-card");
    await expect(card).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    await expect(card).toContainText("Submit the booking");
    await finalReply(page, request);
    // Signed in and filled the form, but nothing submitted yet.
    expect(await (await request.get(`${FIXTURES}/_submissions`)).json()).toHaveLength(0);

    await card.getByTestId("action-confirm").click();
    await expect(card).toHaveAttribute("data-status", "done");
    const reply = await finalReply(page, request);
    expect(reply).toContain("Booking confirmed for Lisa");
    const submissions = await (await request.get(`${FIXTURES}/_submissions`)).json();
    expect(submissions).toEqual([{ name: "Lisa", guests: "2", date: "2026-10-15" }]);
    const detail = await threadDetail(request, id);
    expect(detail.related.some((r: { kind: string; url: string }) => r.kind === "page" && r.url.includes("/booking"))).toBeTruthy();
    // The browser tab's live view shows the page the agent worked on.
    await page.getByTestId("tab-browser").click();
    await expect(page.getByTestId("browser-view").locator("img")).toBeVisible();

    // The panel widens, the page opens full size, and the owner can take the browser over and hand it back.
    const panel = page.getByTestId("side-panel");
    const narrow = (await panel.boundingBox())!.width;
    await page.getByTestId("widen-panel").click();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(narrow);
    await page.getByTestId("browser-takeover").click();
    const stage = page.getByTestId("browser-stage");
    await expect(stage).toHaveClass(/full/);
    await expect(stage).toHaveClass(/controlled/);
    expect((await (await request.get(`/api/threads/${id}/browser/control`)).json()).controlled).toBe(true);
    await stage.locator("img").click();
    await page.getByTestId("browser-takeover").click();
    await expect(stage).not.toHaveClass(/controlled/);
    expect((await (await request.get(`/api/threads/${id}/browser/control`)).json()).controlled).toBe(false);
    await page.getByTestId("browser-full").click();
    await expect(stage).not.toHaveClass(/full/);
  });

  test("[M4.3] credentials never appear in prompts or logs", async ({ request }) => {
    await settle(request);
    const seen = await (await request.get(`/api/test/model-contexts?contains=${encodeURIComponent(SITE_PASSWORD)}`)).json();
    expect(seen.total).toBeGreaterThan(50);
    expect(seen.matching).toBe(0);
    const threads = (await (await request.get("/api/threads")).json()).threads as { id: string }[];
    for (const t of threads) {
      const audit = await (await request.get(`/api/threads/${t.id}/audit`)).text();
      expect(audit).not.toContain(SITE_PASSWORD);
      const detail = await (await request.get(`/api/threads/${t.id}`)).text();
      expect(detail).not.toContain(SITE_PASSWORD);
    }
    const creds = await (await request.get("/api/credentials")).text();
    expect(creds).toContain("lisa");
    expect(creds).not.toContain(SITE_PASSWORD);
    expect(readFileSync(".vireo-test/server.log", "utf8")).not.toContain(SITE_PASSWORD);
    expect(readFileSync(".vireo-test/data/vireo.db").includes(Buffer.from(SITE_PASSWORD))).toBeFalsy();
  });

  test("[M4.4] every action in a thread can be inspected in its audit trail", async ({ page }) => {
    await page.goto("/#threads");
    await page.getByTestId("thread-row").filter({ hasText: /table/i }).first().click();
    await page.getByTestId("tab-activity").click();
    const audit = page.getByTestId("audit");
    await expect(audit).toContainText("Opened a page");
    await expect(audit).toContainText("Typed");
    await expect(audit).toContainText("awaiting confirmation");
    await expect(audit).toContainText("owner"); // the confirmed click, run on the owner's say-so
    await expect(audit).toContainText("Model calls");
    const rows = page.getByTestId("audit-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(6);
    // The sign-in step shows the placeholder, never the stored password.
    const signIn = rows.filter({ hasText: "Typed" }).filter({ hasText: "{{password}}" });
    await signIn.click();
    await expect(signIn).toContainText('"text":"{{password}}"');
    // Usage: the thread's context window and tokens by model.
    await page.getByTestId("tab-usage").click();
    await expect(page.getByTestId("usage-context")).toContainText("Context window");
    await expect(page.getByTestId("usage-model").first()).toBeVisible();
    await expect(page.getByTestId("usage-tokens")).toHaveText(/M$/);
  });

  test("[C8] reminders fire in their thread and notify the owner", async ({ page, request }) => {
    const id = await startThread(page, "Remind me to call mom in 5 minutes");
    expect(await finalReply(page, request)).toContain("remind you");
    const reminders = (await (await request.get("/api/reminders")).json()).reminders as { thread_id: string }[];
    expect(reminders.some((r) => r.thread_id === id)).toBeTruthy();
    expect((await (await request.post("/api/test/reminders")).json()).fired).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("notice-reminder")).toContainText("call mom");
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications;
    expect(notes.some((n: { body: string }) => n.body.includes("call mom"))).toBeTruthy();
  });

  test("[C7] a calendar conflict opens its own thread with options", async ({ request, page }) => {
    const base = Date.now() + 2 * 864e5;
    const at = (h: number) => new Date(Math.floor(base / 864e5) * 864e5 + h * 3600_000).toISOString();
    await request.post("/api/test/event", { data: { title: "Board review", start: at(6), end: at(7) } });
    await request.post("/api/test/event", { data: { title: "Team lunch", start: at(6.5), end: at(7.5) } });
    expect((await (await request.post("/api/test/check-calendar")).json()).opened).toBeGreaterThanOrEqual(1);
    await settle(request);
    const t = (await (await request.get("/api/threads")).json()).threads.find((x: { title: string }) => x.title.includes("Board review"));
    expect(t.group).toBe("needs_you");
    await page.goto(`/#thread/${t.id}`);
    await expect(page.getByTestId("msg-assistant").last()).toContainText("Options");
  });

  test("[C9] files can be attached to a thread and produced files are returned", async ({ page, request }) => {
    const id = await startThread(page, "Keep my packing list here");
    await finalReply(page, request);
    await page.locator('input[type="file"]').setInputFiles({ name: "packing.txt", mimeType: "text/plain", buffer: Buffer.from("passport\ncharger\n") });
    await sendMessage(page, "Here is my packing list");
    await finalReply(page, request);
    const detail = await threadDetail(request, id);
    expect(detail.files.map((f: { name: string }) => f.name)).toContain("packing.txt");
    await expect(page.getByTestId("side-panel")).toContainText("packing.txt");
    const file = await request.get(`/api/files/${detail.files[0].id}`);
    expect(await file.text()).toContain("passport");
  });
});
