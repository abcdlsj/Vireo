import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const FIXTURES = "http://localhost:8790";

/** Waits until every thread run and memory job has finished. */
export async function settle(request: APIRequestContext): Promise<void> {
  const r = await request.post("/api/test/idle");
  expect(r.ok()).toBeTruthy();
}

export async function startThread(page: Page, text: string, opts: { temporary?: boolean } = {}): Promise<string> {
  await page.goto("/#new");
  if (opts.temporary) await page.getByTestId("temporary-toggle").check();
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send").click();
  await page.waitForURL(/#thread\/t_/);
  return decodeURIComponent(page.url().split("#thread/")[1]!);
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId("msg-user").count();
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("msg-user")).toHaveCount(before + 1);
}

/** Text of the newest assistant message once the thread has stopped working. */
export async function finalReply(page: Page, request: APIRequestContext): Promise<string> {
  await settle(request);
  await expect(page.getByTestId("live")).toHaveCount(0);
  return (await page.getByTestId("msg-assistant").last().innerText()).trim();
}

export async function threadDetail(request: APIRequestContext, id: string) {
  const r = await request.get(`/api/threads/${id}`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}
