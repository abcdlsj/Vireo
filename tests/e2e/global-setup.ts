import { request, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const OWNER_PASSWORD = "correct-horse-battery";

/** Creates the owner account once and saves a signed-in session for the tests. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;
  mkdirSync(".vireo-test", { recursive: true });
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/setup", { data: { password: OWNER_PASSWORD, timezone: "Asia/Shanghai" } });
  if (!res.ok()) throw new Error(`setup failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: ".vireo-test/owner.json" });
  await ctx.dispose();
}
