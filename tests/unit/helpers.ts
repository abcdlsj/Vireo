import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../apps/host/src/app.js";
import { loadConfig } from "../../apps/host/src/config.js";
import { Db } from "../../apps/host/src/db.js";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vireo-unit-"));
}

export function tempDb(): { db: Db; dir: string } {
  const dir = tempDir();
  return { db: Db.open(dir), dir };
}

/** A full app on a throwaway data directory, using the scripted model and in-memory mail. */
export function testApp(dir = tempDir()): App {
  // A few services read these directly from the environment.
  process.env.VIREO_SCHEDULER = "off";
  process.env.VIREO_FAKE_TOKENS_PER_SECOND = "5000";
  return createApp(
    loadConfig({
      VIREO_DATA_DIR: dir,
      VIREO_FAKE_MODEL: "1",
      VIREO_FAKE_GOOGLE: "1",
    }),
  );
}
