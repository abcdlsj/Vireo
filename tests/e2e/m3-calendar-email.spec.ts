import { expect, test, type APIRequestContext } from "@playwright/test";
import { OWNER_PASSWORD } from "./global-setup";
import { finalReply, sendMessage, settle, startThread, threadDetail } from "./helpers";

interface Ev {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

async function events(request: APIRequestContext): Promise<Ev[]> {
  return (await (await request.get("/api/test/events")).json()).events;
}

function tomorrowAt(hour: number): string {
  // The owner's time zone in the suite is Asia/Shanghai (UTC+8).
  const now = new Date(Date.now() + 8 * 3600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hour - 8, 0));
  return d.toISOString();
}

test.describe("Milestone 3 — Calendar and email", () => {
  test("[M3.1] scheduling a meeting finds a free slot and creates the event after confirmation", async ({ page, request }) => {
    // Tomorrow is a weekday or not, the first free slot must avoid this busy block.
    await request.post("/api/test/event", { data: { title: "Dentist", start: tomorrowAt(9), end: tomorrowAt(11) } });
    const id = await startThread(page, "Schedule a 30 min meeting with anna@example.com tomorrow");
    const card = page.getByTestId("action-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await expect(card).toContainText("anna@example.com");
    await finalReply(page, request);
    expect((await events(request)).some((e) => e.title === "Meeting with Anna")).toBeFalsy();

    // The thread waits on the owner.
    const listed = (await (await request.get("/api/threads")).json()).threads.find((t: { id: string }) => t.id === id);
    expect(listed.group).toBe("needs_you");
    const notes = (await (await request.get("/api/test/notifications")).json()).notifications;
    expect(notes.some((n: { title: string }) => n.title.startsWith("Confirm:"))).toBeTruthy();

    await card.getByTestId("action-confirm").click();
    await expect(card).toHaveAttribute("data-status", "done");
    const reply = await finalReply(page, request);
    expect(reply).toContain("on your calendar");
    const created = (await events(request)).find((e) => e.title === "Meeting with Anna")!;
    expect(created.attendees).toEqual(["anna@example.com"]);
    const dentist = (await events(request)).find((e) => e.title === "Dentist")!;
    const overlaps = Date.parse(created.start) < Date.parse(dentist.end) && Date.parse(created.end) > Date.parse(dentist.start);
    expect(overlaps).toBeFalsy();
    expect(Date.parse(created.end) - Date.parse(created.start)).toBe(30 * 60_000);
  });

  test("[M3.2] an email needing a reply opens its own thread with a summary and a draft; sending needs confirmation", async ({ page, request }) => {
    await request.post("/api/test/email", { data: { from: "Weekly Digest <noreply@news.example>", subject: "Your weekly newsletter", body: "Top stories. Unsubscribe anytime." } });
    await request.post("/api/test/email", {
      data: { from: "Ben Carter <ben@example.com>", subject: "Lunch on Friday?", body: "Hi! Are you free for lunch on Friday at noon? Let me know." },
    });
    const opened = (await (await request.post("/api/test/check-inbox")).json()).opened;
    expect(opened).toBe(1); // the newsletter does not need a reply
    await settle(request);

    const threads = (await (await request.get("/api/threads")).json()).threads as { id: string; title: string; group: string }[];
    const t = threads.find((x) => x.title.includes("Lunch on Friday"))!;
    expect(t).toBeTruthy();
    expect(t.group).toBe("needs_you");
    const sentBefore = (await (await request.get("/api/test/sent")).json()) as { sent: unknown[]; drafts: { to: string }[] };
    expect(sentBefore.sent).toHaveLength(0);
    expect(sentBefore.drafts.some((d) => d.to === "ben@example.com")).toBeTruthy();

    await page.goto(`/#thread/${t.id}`);
    const reply = page.getByTestId("msg-assistant").last();
    await expect(reply).toContainText("Summary");
    await expect(reply).toContainText("Draft reply");

    await sendMessage(page, "Yes, send it");
    const card = page.getByTestId("action-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await finalReply(page, request);
    expect((await (await request.get("/api/test/sent")).json()).sent).toHaveLength(0);

    // Edit before confirming: the owner's edit is what gets sent.
    await card.getByTestId("action-edit").click();
    await card.getByTestId("edit-body").fill("Hi Ben, Friday at noon works. See you then!");
    await card.getByTestId("action-confirm").click();
    await expect(card).toHaveAttribute("data-status", "done");
    const sent = (await (await request.get("/api/test/sent")).json()).sent as { to: string; body: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ben@example.com");
    expect(sent[0]!.body).toBe("Hi Ben, Friday at noon works. See you then!");
    expect(await finalReply(page, request)).toContain("Sent");
  });

  test("[M3.3] a confirmation tapped on the phone resumes the paused work", async ({ page, browser, request, baseURL }) => {
    const id = await startThread(page, "Schedule a 45 minutes meeting with carol@example.com tomorrow");
    await expect(page.getByTestId("action-card")).toHaveAttribute("data-status", "pending");
    await finalReply(page, request);

    // The phone signs in separately and confirms from there.
    const phone = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    await p.goto("/");
    await p.locator("input[type=password]").fill(OWNER_PASSWORD);
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.locator(`[data-testid="group-needs_you"] [data-thread-id="${id}"]`).click();
    await p.getByTestId("action-confirm").click();
    await expect(p.getByTestId("action-card")).toHaveAttribute("data-status", "done");
    await phone.close();

    // The desktop sees the work resume and finish live.
    await expect(page.getByTestId("action-card")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("msg-assistant").last()).toContainText("on your calendar");
    expect((await events(request)).some((e) => e.attendees.includes("carol@example.com"))).toBeTruthy();
    const { thread } = await threadDetail(request, id);
    expect(thread.group).toBe("in_progress");
  });

  test("[M3.4] nothing outward-facing happens without confirmation", async ({ page, request }) => {
    // Cancelling keeps the world unchanged.
    await startThread(page, "Schedule a 30 min meeting with dave@example.com tomorrow");
    const card = page.getByTestId("action-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await card.getByTestId("action-cancel").click();
    await expect(card).toHaveAttribute("data-status", "cancelled");
    expect(await finalReply(page, request)).toContain("won't");
    expect((await events(request)).some((e) => e.attendees.includes("dave@example.com"))).toBeFalsy();

    // Across every thread so far, no model-initiated outward call ever ran directly:
    // each one stopped at "awaiting confirmation", and only the owner ran them.
    const threads = (await (await request.get("/api/threads")).json()).threads as { id: string }[];
    let outward = 0;
    for (const t of threads) {
      const { toolCalls } = (await (await request.get(`/api/threads/${t.id}/audit`)).json()) as {
        toolCalls: { tool: string; agent: string; args: string; status: string }[];
      };
      for (const c of toolCalls) {
        const args = JSON.parse(c.args) as { attendees?: string[] };
        const isOutward = ["send_email", "delete_event", "respond_to_invite"].includes(c.tool) || (c.tool === "create_event" && (args.attendees?.length ?? 0) > 0);
        if (!isOutward) continue;
        outward += 1;
        if (c.agent === "owner") expect(["ok", "error"]).toContain(c.status);
        else expect(c.status).toBe("awaiting_confirmation");
      }
    }
    expect(outward).toBeGreaterThanOrEqual(4);
  });
});
