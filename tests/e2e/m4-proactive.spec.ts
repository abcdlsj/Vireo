import { expect, test } from "./helpers";
import { readFileSync } from "node:fs";
import { finalReply, FIXTURES, sendMessage, settle, startThread, threadDetail } from "./helpers";

const SITE_PASSWORD = "s3cret-Pa55word!";

test.describe("Milestone 4 — Proactive and hands-on", () => {
  test.afterEach(async ({ request }) => {
    for (const a of test.info().annotations) if (a.type === "thread") await request.post(`/api/threads/${a.description}/browser/control`, { data: { on: false } });
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

  test("[M4.2] when Vireo hands its browser over, the ask is in the conversation, on the board and in a notification", async ({ page, request }) => {
    const controlled = async () => (await (await request.get(`/api/threads/${id}/browser/control`)).json()).controlled as boolean;
    const r = await request.post("/api/threads", { data: { text: `Book a table for 2 people at ${FIXTURES}/login under the name Lisa, I'll sign in myself` } });
    const id = (await r.json()).thread.id as string;
    // Never leave the run waiting on the owner for later tests.
    test.info().annotations.push({ type: "thread", description: id });
    await expect.poll(controlled, { timeout: 30_000 }).toBe(true);
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications;
    expect(notes[0]).toMatchObject({ title: expect.stringContaining("Your turn in the browser"), body: "Sign in to Bistro Vireo", url: `/#thread/${id}?browser` });

    // The board puts it under "Needs you", and its button opens the browser in the thread.
    await page.goto("/#");
    const card = page.getByTestId("board-needs").locator('[data-kind="browser_request"]');
    await expect(card).toContainText("Sign in to Bistro Vireo");
    await expect(page.getByTestId("home-headline")).toContainText("need");
    await card.getByTestId("browser-request-open").click();
    const full = page.locator(".browser-stage.full");
    await expect(full).toHaveClass(/controlled/);
    await expect(full.getByTestId("browser-request")).toContainText("Sign in to Bistro Vireo");

    // Closing the view or leaving the thread doesn't answer the ask: it waits in the conversation.
    await full.getByTestId("browser-full").click();
    await expect(full).toHaveCount(0);
    const ask = page.getByTestId("browser-ask");
    await expect(ask).toContainText("Sign in to Bistro Vireo");
    await page.goto("/#");
    await page.goto(`/#thread/${id}`);
    expect(await controlled()).toBe(true);
    // On a wide screen the browser opens by itself while Vireo waits on it.
    await expect(full).toBeVisible();
    await full.getByTestId("browser-full").click();

    await ask.getByTestId("browser-request-done").click();
    await expect(page.getByTestId("browser-ask-ended")).toContainText("You handed the browser back");
    await settle(request);
    expect(await controlled()).toBe(false);
    const feed = (await (await request.get("/api/cards")).json()).cards as { kind: string }[];
    expect(feed.some((c) => c.kind === "browser_request")).toBe(false);
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
    const reminders = (await (await request.get("/api/reminders")).json()).reminders as { threadId: string }[];
    expect(reminders.some((r) => r.threadId === id)).toBeTruthy();
    expect((await (await request.post("/api/test/reminders")).json()).fired).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("notice-reminder")).toContainText("call mom");
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications;
    expect(notes.some((n: { body: string }) => n.body.includes("call mom"))).toBeTruthy();
  });

  test("[C8] the daily nudge says what needs the owner", async ({ request }) => {
    const r = await (await request.post("/api/test/nudge")).json();
    expect(r.needs).toBeGreaterThanOrEqual(1); // the reminder above, at least
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications as { body: string; tag?: string }[];
    expect(notes.some((n) => /needs? you/.test(n.body))).toBeTruthy();
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

    // The upload sits on the owner's message as a file, and Vireo read it before answering.
    const sent = page.getByTestId("msg-user").last();
    await expect(sent.getByTestId("attachment")).toContainText("packing.txt");
    await expect(sent).not.toContainText("Attached file");
    await expect(page.getByTestId("msg-assistant").last()).toContainText('starts with "passport"');
    await sent.getByTestId("attachment").click();
    await expect(page.getByTestId("file-viewer")).toContainText("charger");
    await page.getByTestId("viewer-close").click();
    await expect(page.getByTestId("file-viewer")).toHaveCount(0);

    // What Vireo writes up comes back under its reply and opens rendered.
    await sendMessage(page, "Write it up as a document");
    await finalReply(page, request);
    const made = page.getByTestId("produced-files").last();
    await expect(made).toContainText("notes.md");
    await made.getByTestId("attachment").click();
    await expect(page.getByTestId("file-viewer").locator("table")).toContainText("Review");
    await page.getByTestId("viewer-close").click();

    // A page runs live in a sandbox.
    await sendMessage(page, "Write it up as a page");
    await finalReply(page, request);
    await page.getByTestId("produced-files").last().getByTestId("attachment").click();
    const frame = page.frameLocator('[data-testid="viewer-page"]');
    await frame.getByRole("button", { name: "Try me" }).click();
    await expect(frame.getByRole("button", { name: "Clicked" })).toBeVisible();
  });

  test("[M4.2] the owner types into the browser they took over, from a keyboard, an input method or a phone", async ({ page, request }) => {
    await request.get(`${FIXTURES}/_reset`);
    const r = await request.post("/api/threads", { data: { text: `Book a table for 2 people at ${FIXTURES}/login under the name Lisa, I'll sign in myself` } });
    const id = (await r.json()).thread.id as string;
    test.info().annotations.push({ type: "thread", description: id });
    await expect.poll(async () => (await (await request.get(`/api/threads/${id}/browser/control`)).json()).controlled, { timeout: 30_000 }).toBe(true);
    await page.goto(`/#thread/${id}?browser`);
    const full = page.locator(".browser-stage.full");
    await expect(full).toHaveClass(/controlled/);
    const keys = full.getByTestId("browser-keys");
    // Typing goes to a real text field, so keyboards, input methods and phones all have somewhere to type.
    await expect(keys).toBeFocused();
    await full.locator("img").click({ position: { x: 4, y: 4 } });
    await expect(keys).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.type("lisa");
    await page.keyboard.press("Tab");
    // A phone keyboard or an input method sends text with no key events, and deletes the same way.
    await page.keyboard.insertText("s3cret-Pa55wordX");
    await keys.evaluate((el: HTMLTextAreaElement) => {
      el.value = "";
      el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
    });
    await page.keyboard.insertText("!");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await request.get(`${FIXTURES}/_logins`)).json()).toEqual([{ u: "lisa", ok: true }]);
  });
});
