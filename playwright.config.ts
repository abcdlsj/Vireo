import { defineConfig, devices } from "@playwright/test";

const PORT = 8797;
/** The host runs headless; the app on PORT serves the UI and proxies /api to it. */
const HOST_PORT = 8798;
const FIXTURE_PORT = 8790;
const DATA = ".vireo-test/data";

/**
 * End-to-end suite. Runs the built server with the scripted model and an
 * in-memory mailbox, plus a fixture site for research and browser tasks.
 * Each test title carries the PRD acceptance criterion it covers.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: ".vireo-test/results.json" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    storageState: ".vireo-test/owner.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node tests/fixtures/server.mjs`,
      port: FIXTURE_PORT,
      env: { FIXTURE_PORT: String(FIXTURE_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `rm -rf ${DATA} .vireo-test/server.log && node --disable-warning=ExperimentalWarning apps/host/dist/index.js`,
      port: HOST_PORT,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        VIREO_PORT: String(HOST_PORT),
        VIREO_DATA_DIR: DATA,
        VIREO_FAKE_MODEL: "1",
        VIREO_FAKE_GOOGLE: "1",
        VIREO_TEST_MODE: "1",
        VIREO_SCHEDULER: "off",
        VIREO_FAKE_TOKENS_PER_SECOND: "300",
        VIREO_SEARCH_ENDPOINT: `http://localhost:${FIXTURE_PORT}/search`,
        VIREO_LOG_FILE: ".vireo-test/server.log",
      },
    },
    {
      command: `node apps/web/serve.mjs`,
      port: PORT,
      reuseExistingServer: false,
      env: { VIREO_APP_PORT: String(PORT), VIREO_HOST_URL: `http://127.0.0.1:${HOST_PORT}` },
    },
  ],
});
