import { expect, test } from "@playwright/test";
import { OWNER_PASSWORD } from "./global-setup";
import { finalReply, sendMessage, settle, startThread, threadDetail } from "./helpers";

test.describe("Milestone 1 — Threads that think", () => {
  test("[M1.1] the PWA is installable and the owner signs in on a new device", async ({ browser, request, baseURL }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBeTruthy();
    expect((await request.get("/icon-192.png")).headers()["content-type"]).toBe("image/png");
    expect(await (await request.get("/sw.js")).text()).toContain('addEventListener("push"');

    // A fresh device (iPhone-sized, no session) must sign in.
    const phone = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
    await expect(page.getByText("Sign in to This machine")).toBeVisible();
    await page.locator("input[type=password]").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong password")).toBeVisible();
    await page.locator("input[type=password]").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("home")).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined || "serviceWorker" in navigator)).toBeTruthy();
    await phone.close();

    // The API refuses requests without a session.
    const anon = await (await import("@playwright/test")).request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    expect((await anon.get("/api/threads")).status()).toBe(401);
    await anon.dispose();
  });

  test("[M1.2] a new thread gets a name and a streamed answer", async ({ page, request }) => {
    const deltas: string[] = [];
    await page.exposeFunction("recordDelta", (d: string) => deltas.push(d));
    await page.addInitScript(() => {
      const Orig = window.EventSource;
      // Spy on the live event stream to observe incremental text deltas.
      window.EventSource = class extends Orig {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", (e) => {
            const data = JSON.parse((e as MessageEvent).data);
            if (data.type === "message.delta") (window as unknown as { recordDelta: (d: string) => void }).recordDelta(data.delta);
          });
        }
      } as typeof EventSource;
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
