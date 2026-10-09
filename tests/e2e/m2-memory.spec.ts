import { expect, test } from "@playwright/test";
import { finalReply, settle, startThread } from "./helpers";

interface Fact {
  id: string;
  statement: string;
  key: string;
  current: boolean;
  sourceThreadId: string | null;
}

async function facts(request: import("@playwright/test").APIRequestContext, query = "", history = false): Promise<Fact[]> {
  const r = await request.get(`/api/memory?query=${encodeURIComponent(query)}${history ? "&history=1" : ""}`);
  return (await r.json()).facts;
}

test.describe("Milestone 2 — Vireo remembers", () => {
  test("[M2.1] a preference stated in one thread is used unprompted in a new thread", async ({ page, request }) => {
    const first = await startThread(page, "By the way, I prefer aisle seats on flights.");
    await finalReply(page, request);
    const remembered = await facts(request, "aisle");
    expect(remembered.length).toBe(1);
    expect(remembered[0]!.sourceThreadId).toBe(first);

    await startThread(page, "Book me a flight to Shanghai on Oct 15");
    const reply = await finalReply(page, request);
    expect(reply.toLowerCase()).toContain("aisle");
  });

  test("[M2.2] a changed fact replaces the old one", async ({ page, request }) => {
    await startThread(page, "My home address is 1 Old Street, Springfield.");
    await finalReply(page, request);
    await startThread(page, "I moved to 99 New Road, Shelbyville.");
    await finalReply(page, request);

    const current = await facts(request, "address");
    expect(current.map((f) => f.statement)).toEqual(["Owner's home address is 99 New Road, Shelbyville"]);
    const all = await facts(request, "address", true);
    const old = all.find((f) => f.statement.includes("Old Street"))!;
    expect(old.current).toBe(false);

    await startThread(page, "Where do I live?");
    const reply = await finalReply(page, request);
    expect(reply).toContain("99 New Road");
    expect(reply).not.toContain("Old Street");

    await page.goto("/#memory");
    await page.getByText("Show replaced and expired").click();
    const stale = page.locator('[data-testid="fact"][data-current="0"]', { hasText: "Old Street" });
    await expect(stale).toBeVisible();
    await expect(stale).toContainText("replaced");
  });

  test("[M2.1] the thread shows what Vireo remembered, and Forget takes it back", async ({ page, request }) => {
    await startThread(page, "I prefer green tea in the morning.");
    await finalReply(page, request);
    const note = page.getByTestId("remembered");
    await expect(note).toContainText("green tea");
    await note.getByTestId("forget-fact").first().click();
    await expect(note).toContainText("Forgotten");
    expect(await facts(request, "green tea")).toHaveLength(0);
  });

  test("[M2.3] 'what do you remember' returns facts with sources, and the owner can correct and delete them", async ({ page, request }) => {
    await startThread(page, "Anna is my sister. Anna's email is anna@example.com");
    await finalReply(page, request);

    await startThread(page, "What do you remember about Anna?");
    const reply = await finalReply(page, request);
    expect(reply).toContain("Anna is the owner's sister");
    expect(reply).toContain("source:");

    await page.goto("/#memory");
    await page.getByTestId("memory-search").fill("Anna");
    const fact = page.getByTestId("fact").filter({ hasText: "owner's sister" });
    await expect(fact).toBeVisible();
    await expect(fact.getByRole("link")).toContainText("from");

    // Correct it.
    await fact.getByTestId("fact-edit").click();
    await page.getByTestId("fact-input").fill("Anna is the owner's younger sister");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("fact").filter({ hasText: "younger sister" })).toBeVisible();
    expect((await facts(request, "sister")).map((f) => f.statement)).toEqual(["Anna is the owner's younger sister"]);

    // Delete the email fact.
    const email = page.getByTestId("fact").filter({ hasText: "anna@example.com" });
    await email.getByTestId("fact-delete").click();
    await expect(email).toHaveCount(0);
    expect((await facts(request, "Anna")).filter((f) => f.statement.includes("anna@example.com"))).toHaveLength(0);
  });

  test("[M2.4] temporary threads leave nothing in memory", async ({ page, request }) => {
    const before = (await request.get("/api/memory?history=1").then((r) => r.json())).facts.length;
    const id = await startThread(page, "I prefer window seats when I fly at night.", { temporary: true });
    await finalReply(page, request);
    await settle(request);
    expect(await facts(request, "window", true)).toHaveLength(0);
    expect((await request.get("/api/memory?history=1").then((r) => r.json())).facts.length).toBe(before);
    const episodes = (await request.get("/api/memory").then((r) => r.json())).episodes as { threadId: string }[];
    expect(episodes.some((e) => e.threadId === id)).toBeFalsy();
  });
});
