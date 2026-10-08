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
    await expect(page.getByText("Welcome back")).toBeVisible();
    await page.locator("input[type=password]").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong password")).toBeVisible();
    await page.locator("input[type=password]").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("thread-list")).toBeVisible();
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

    await page.goto("/#settings");
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
