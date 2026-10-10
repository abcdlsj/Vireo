import { devices, request as http } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { expect, finalReply, linked, NODE, sendMessage, settle, signIn, startThread, test, threadDetail } from "./helpers";

test.describe("Milestone 1 — Threads that think", () => {
  test("[M1.1] the PWA is installable and the owner signs in on a new device", async ({ browser, baseURL }) => {
    const app = await http.newContext({ baseURL });
    const manifest = await (await app.get("/manifest.webmanifest")).json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBeTruthy();
    expect((await app.get("/icon-192.png")).headers()["content-type"]).toBe("image/png");
    expect(await (await app.get("/sw.js")).text()).toContain('addEventListener("push"');

    // A fresh device (iPhone-sized, no session) must sign in, then lands on its node.
    const phone = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
    await expect(page.getByRole("heading", { name: "Welcome to Vireo" })).toBeVisible();
    await signIn(page);
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("node-switch").first()).toContainText("Test node");
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined || "serviceWorker" in navigator)).toBeTruthy();
    await phone.close();

    // Neither the node nor the relay answers without a token.
    expect((await app.get(`/n/${linked().nodeId}/api/threads`)).status()).toBe(401);
    const anon = await http.newContext({ baseURL: NODE });
    expect((await anon.get("/api/threads")).status()).toBe(401);
    expect((await anon.get("/api/threads", { headers: { authorization: `Bearer ${linked().session}` } })).status()).toBe(401);
    await anon.dispose();
    await app.dispose();
  });

  test("[M1.2] a new thread gets a name and a streamed answer", async ({ page, request }) => {
    const deltas: string[] = [];
    await page.exposeFunction("recordDelta", (d: string) => deltas.push(d));
    await page.addInitScript(() => {
      // Spy on the live event stream (read with fetch, through the relay) to see text arrive in pieces.
      const orig = window.fetch;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const res = await orig(...args);
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (!url.endsWith("/api/events") || !res.body) return res;
        const [mine, theirs] = res.body.tee();
        void (async () => {
          const reader = theirs.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk.includes('"type":"message.delta"')) (window as unknown as { recordDelta: (d: string) => void }).recordDelta(chunk);
          }
        })();
        return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
      };
    });
    const id = await startThread(page, "Explain how a vireo builds its nest");
    await expect(page.getByTestId("live")).toBeVisible();
    const reply = await finalReply(page, request);
    expect(reply.length).toBeGreaterThan(40);
    expect(deltas.length).toBeGreaterThan(3); // arrived in pieces, not all at once
    const { thread } = await threadDetail(request, id);
    expect(thread.title).not.toBe("New thread");
    expect(thread.title.toLowerCase()).toContain("vireo");
    await expect(page.getByTestId("thread-title")).toContainText(thread.title);
    await expect(page.locator(`[data-thread-id="${id}"]`).first()).toBeVisible();
  });

  test("[M1.3] two threads running at once do not mix context", async ({ page, request }) => {
    const a = (await (await request.post("/api/threads", { data: { text: "My code word is ALPHA. What is my code word?" } })).json()).thread.id;
    const b = (await (await request.post("/api/threads", { data: { text: "My code word is BRAVO. What is my code word?" } })).json()).thread.id;
    // Both are working at the same time.
    const running = (await (await request.get("/api/threads")).json()).threads.filter((t: { id: string; running: boolean }) => [a, b].includes(t.id) && t.running);
    expect(running.length).toBe(2);
    await settle(request);

    await page.goto(`/#thread/${a}`);
    await expect(page.getByTestId("msg-assistant").last()).toContainText("ALPHA");
    await sendMessage(page, "What is my code word?");
    expect(await finalReply(page, request)).toContain("ALPHA");

    await page.goto(`/#thread/${b}`);
    await expect(page.getByTestId("msg-assistant").last()).toContainText("BRAVO");
    await sendMessage(page, "What is my code word?");
    const replyB = await finalReply(page, request);
    expect(replyB).toContain("BRAVO");
    expect(replyB).not.toContain("ALPHA");
  });

  test("[M1.4] a research question returns a sourced summary", async ({ page, request }) => {
    const id = await startThread(page, "Research the vireo bird and where its name comes from");
    const reply = await finalReply(page, request);
    expect(reply).toContain("Sources");
    const links = page.getByTestId("msg-assistant").last().locator("a[href^='http://localhost:8790/pages/']");
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    // The pages read are listed in the side panel.
    await expect(page.getByTestId("side-panel")).toContainText("Vireo — Bird Encyclopedia");
    const detail = await threadDetail(request, id);
    expect(detail.related.filter((r: { kind: string }) => r.kind === "page").length).toBeGreaterThanOrEqual(2);
    // The answer is a card, on the thread and on the home board.
    expect(detail.cards).toEqual([expect.objectContaining({ kind: "card" })]);
    await expect(page.getByTestId("thread-cards").locator('[data-kind="card"]')).toContainText("vireo");
    await page.goto("/");
    const card = page.getByTestId("board").locator('[data-kind="card"]').filter({ hasText: "Research the vireo bird" });
    await expect(card).toBeVisible();
    // A card opens in place: the card in full and a line to answer it; the thread is one tap away.
    await card.click();
    const peek = page.getByTestId("peek");
    await expect(peek.locator('[data-kind="card"]')).toContainText("vireo");
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await card.click();
    await peek.getByTestId("peek-open").click();
    await expect(page.getByTestId("thread-view")).toHaveAttribute("data-thread-id", id);
  });

  test("[Errors] a failed run can be tried again from the thread", async ({ page, request }) => {
    await startThread(page, "Please simulate a model error");
    await settle(request);
    await expect(page.getByTestId("notice-error")).toBeVisible();
    await page.getByTestId("retry").click();
    await settle(request);
    await expect(page.getByTestId("msg-assistant")).toHaveCount(1);
    await expect(page.getByTestId("retry")).toHaveCount(0);
  });

  test("[Home] what still needs setting up is listed until done or hidden", async ({ page }) => {
    await page.goto("/");
    const setup = page.getByTestId("setup");
    await expect(setup).toContainText("Connect Google");
    await setup.getByTestId("setup-hide").click();
    await expect(setup).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(page.getByTestId("setup")).toHaveCount(0);
  });

  test("[Share] text shared from another app waits in the ask box", async ({ page }) => {
    await page.goto("/share?title=Ramen%20place&text=Try%20this%20one%20https%3A%2F%2Fexample.com%2Framen&url=https%3A%2F%2Fexample.com%2Framen");
    await expect(page).toHaveURL(/\/#$/);
    await expect(page.getByTestId("ask-input")).toHaveValue("Ramen place\nTry this one https://example.com/ramen");
  });

  test("[Home] each ask becomes a card on the board, answered in place", async ({ page, request }) => {
    await page.goto("/");
    await page.getByTestId("ask-input").fill("What is a good name for a houseplant?");
    await page.getByTestId("ask-send").click();
    await settle(request);
    // The ask opens in the peek sheet, so the answer is read without leaving the board.
    await expect(page.getByTestId("peek")).toContainText("scripted demo model");
    const first = page.getByTestId("board").locator('[data-kind="thread"]').filter({ hasText: /houseplant/i });
    const threadId = await first.getAttribute("data-thread-id");
    const card = page.getByTestId("board").locator(`[data-thread-id="${threadId}"]`);
    // Answering from the peek sheet keeps the owner on the board.
    await page.getByTestId("peek-input").fill("Something for a sunny window, please");
    await page.getByTestId("peek-send").click();
    await settle(request);
    await expect(page.getByTestId("peek")).toContainText("sunny window");
    await page.getByTestId("peek-close").click();
    await expect(page.getByTestId("peek")).toHaveCount(0);
    // Closing the matter from the card's corner takes it off the board.
    await card.hover();
    await card.getByTestId("card-done").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("done-strip").locator(`a[href="#thread/${threadId}"]`)).toBeVisible();
    // The sidebar beside the board still lists every thread.
    await expect(page.getByTestId("thread-list")).toContainText(/houseplant/i);
    // ⌘K finds a matter by what it is about and opens it.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("quick-jump-input").fill("houseplant");
    await expect(page.getByTestId("quick-jump-item").first()).toContainText("Done");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#thread/${threadId}`));
    await expect(page.getByTestId("quick-jump")).toHaveCount(0);
  });

  test("[Home] a long card shows its summary, and its quick replies answer from the board on a phone", async ({ browser, baseURL, request }) => {
    const thread = (await (await request.post("/api/threads", { data: { title: "Flights to Shanghai" } })).json()).thread;
    // A card as a model would show it: many rows, one marked best, a note, and quick replies.
    const now = Date.now();
    const flights = ["CA1831", "MU5102", "HO1252", "CZ3907", "FM9108", "CA1557", "MU5138", "9C8846"];
    const data = {
      blocks: [
        { type: "rows", items: flights.map((title, i) => ({ title, value: `¥${1000 + i * 10}`, mark: title === "FM9108" ? "best" : undefined })) },
        { type: "text", text: "FM9108 is the best value." },
      ],
    };
    const db = new DatabaseSync(".vireo-test/data/vireo.db");
    db.prepare("INSERT INTO cards (id, thread_id, kind, title, status, data, buttons, archived, created_at, updated_at) VALUES (?, ?, 'card', ?, 'needs_you', ?, ?, 0, ?, ?)").run(
      "c_flights",
      thread.id,
      "Beijing to Shanghai, Friday",
      JSON.stringify(data),
      JSON.stringify([{ label: "Book FM9108", reply: "Book FM9108", primary: true }, { label: "Later flights", reply: "Show later flights" }]),
      now,
      now,
    );
    db.close();

    const { defaultBrowserType: _, ...phone } = devices["iPhone 13"];
    const context = await browser.newContext({ ...phone, baseURL, storageState: ".vireo-test/owner.json" });
    const page = await context.newPage();
    await page.goto("/");
    const card = page.getByTestId("board").locator(`[data-thread-id="${thread.id}"]`);
    // The board shows the top rows and the best one; the rest wait in the peek.
    await expect(card.locator(".g-rows li")).toHaveCount(3);
    await expect(card).toContainText("FM9108");
    await expect(card.getByTestId("card-more")).toHaveText("5 more");
    // A tap on a quick reply answers the matter without opening it.
    await card.getByRole("button", { name: "Book FM9108" }).tap();
    await expect(card.getByTestId("card-sent")).toContainText("Book FM9108");
    await expect(page.getByTestId("peek")).toHaveCount(0);
    await settle(request);
    const messages = (await threadDetail(request, thread.id)).messages as { role: string; text: string }[];
    expect(messages.some((m) => m.role === "user" && m.text === "Book FM9108")).toBe(true);
    // Opening the card shows every row.
    await card.locator(".c-title").tap();
    await expect(page.getByTestId("peek").locator(".g-rows li")).toHaveCount(8);
    await context.close();
  });

  test("[Thread] on a phone the details are a sheet that drags taller and closes every way", async ({ browser, baseURL, request }) => {
    const thread = (await (await request.post("/api/threads", { data: { text: "What is a good name for a fern?" } })).json()).thread;
    await settle(request);
    const { defaultBrowserType: _, ...phone } = devices["iPhone 13"];
    const context = await browser.newContext({ ...phone, baseURL, storageState: ".vireo-test/owner.json" });
    const page = await context.newPage();
    /** Waits for the sheet to stop moving (its rise, or growing and shrinking). */
    const settled = () => page.evaluate(() => Promise.all(document.querySelector("[data-testid=side-panel]")?.getAnimations().map((a) => a.finished) ?? []));
    /** Drags the sheet's handle by dy (pointer events, as a finger sends them). */
    const drag = async (dy: number) => {
      const b = (await page.getByTestId("sheet-grab").boundingBox())!;
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(50);
      await settled();
    };
    await page.goto(`/#thread/${thread.id}`);
    const panel = page.getByTestId("side-panel");
    const open = async () => {
      await page.getByTestId("toggle-panel").tap();
      await expect(panel).toBeVisible();
      await settled();
    };
    await open();
    const start = (await panel.boundingBox())!.height;
    // Up makes room; down from there shrinks it back, and down again puts it away.
    await drag(-200);
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(start + 100);
    await drag(150);
    await expect.poll(async () => Math.round((await panel.boundingBox())!.height)).toBe(Math.round(start));
    await drag(200);
    await expect(panel).toHaveCount(0);
    // Tabs still switch, and the X and a tap beside the sheet both close it.
    await open();
    await page.getByTestId("tab-activity").tap();
    await expect(page.locator(".panel-tabs button.on")).toHaveText("Activity");
    await page.getByRole("button", { name: "Close" }).tap();
    await expect(panel).toHaveCount(0);
    await open();
    await page.getByTestId("sheet-backdrop").tap({ position: { x: 20, y: 20 } });
    await expect(panel).toHaveCount(0);
    // Held sideways the phone is wide, but the details still rise from the bottom.
    await page.setViewportSize({ width: 844, height: 390 });
    await open();
    await expect(page.getByTestId("sheet-grab")).toBeVisible();
    expect((await panel.boundingBox())!.width).toBe(844);
    await context.close();
  });

  test("[M1.5] model access is configurable", async ({ page, request }) => {
    // The endpoint's models are listed over the OpenAI API, and the owner can pick per tier.
    const models = await (await request.get("/api/models")).json();
    expect(models.ready).toBeTruthy();
    expect(models.available).toEqual(expect.arrayContaining(["fake-main", "fake-fast"]));
    expect(models.fast).toBe("fake-fast");
    await request.put("/api/models", { data: { fastModel: "fake-main" } });
    expect((await (await request.get("/api/models")).json()).fast).toBe("fake-main");
    await request.put("/api/models", { data: { fastModel: "" } });
    expect((await (await request.get("/api/models")).json()).fast).toBe("fake-fast");

    await page.goto("/#settings/model");
    const card = page.getByTestId("models-card");
    await expect(card).toContainText("fake-main");
    await card.getByTestId("llm-test").click();
    await expect(card.getByTestId("llm-test-result")).toContainText("Connected");
  });

  test("[C1] Overview answers quick things and opens a thread for multi-step matters", async ({ page, request }) => {
    await page.goto("/#thread/overview");
    await sendMessage(page, "Help me plan a trip to Kyoto in November");
    const reply = await finalReply(page, request);
    expect(reply).toContain("opened a thread");
    const link = page.getByTestId("msg-assistant").last().locator("a[href^='#thread/']");
    await link.click();
    await expect(page.getByTestId("thread-title")).toContainText(/Kyoto/i);
    // The new thread starts from Vireo's restated brief.
    await expect(page.getByTestId("vireo-task").first()).toContainText("Kyoto");
  });

  test("[Lifecycle] marking a thread done summarises it and it can be reopened", async ({ page, request }) => {
    const id = await startThread(page, "Write a two line poem about autumn");
    await finalReply(page, request);
    await page.getByTestId("mark-done").click();
    await expect(page.locator(`[data-testid="group-done"] [data-thread-id="${id}"]`)).toBeVisible();
    const { thread } = await threadDetail(request, id);
    expect(thread.state).toBe("done");
    expect(thread.summary).toBeTruthy();
    // Finding an earlier matter, including closed threads.
    const found = await (await request.get("/api/threads")).json();
    expect(found.threads.find((t: { id: string }) => t.id === id).group).toBe("done");
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.locator(`[data-testid="group-in_progress"] [data-thread-id="${id}"]`)).toBeVisible();
  });
});
