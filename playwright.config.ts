import { defineConfig, devices } from "@playwright/test";

/** The cloud: signs people in, serves the app, relays to nodes. */
const PORT = 8797;
/** The node: the agent and its API, linked to the test account in global setup. */
const NODE_PORT = 8798;
const FIXTURE_PORT = 8790;

/**
 * End-to-end suite. Runs the built cloud (serving the built app, with
 * development sign-in) and a node with the scripted model and an in-memory
 * mailbox, plus a fixture site for research and browser tasks. The app
 * reaches the node through the cloud relay, as it does for real. Each test
 * title carries the PRD acceptance criterion it covers.
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
      command: `rm -rf .vireo-test/cloud && node --disable-warning=ExperimentalWarning apps/cloud/dist/index.js`,
      port: PORT,
      reuseExistingServer: false,
      env: {
        VIREO_CLOUD_PORT: String(PORT),
        VIREO_CLOUD_URL: `http://localhost:${PORT}`,
        VIREO_CLOUD_DATA_DIR: ".vireo-test/cloud",
        VIREO_WEB_DIR: "apps/web/dist",
        VIREO_DEV_LOGIN: "1",
        // Tokens outlive the suite, so the API helper can keep one.
        VIREO_ACCESS_TTL_MS: String(24 * 3600_000),
      },
    },
    {
      command: `rm -rf .vireo-test/data .vireo-test/server.log && node --disable-warning=ExperimentalWarning apps/node/dist/index.js`,
      port: NODE_PORT,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        VIREO_PORT: String(NODE_PORT),
        VIREO_DATA_DIR: ".vireo-test/data",
        VIREO_CLOUD_URL: `http://localhost:${PORT}`,
        VIREO_NAME: "Test node",
        VIREO_FAKE_MODEL: "1",
        VIREO_FAKE_GOOGLE: "1",
        VIREO_TEST_MODE: "1",
        VIREO_SCHEDULER: "off",
        VIREO_FAKE_TOKENS_PER_SECOND: "300",
        VIREO_SEARCH_ENDPOINT: `http://localhost:${FIXTURE_PORT}/search`,
        VIREO_LOG_FILE: ".vireo-test/server.log",
      },
    },
  ],
});
