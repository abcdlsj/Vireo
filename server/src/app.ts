import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Actions } from "./actions.js";
import { Auth } from "./auth.js";
import { BrowserService } from "./browser.js";
import type { Config } from "./config.js";
import { Db } from "./db.js";
import { Files } from "./files.js";
import { Integrations } from "./integrations/index.js";
import { MemoryStore } from "./memory.js";
import { MemoryWorker } from "./memory-worker.js";
import { ModelService } from "./models.js";
import { Pairing } from "./pairing.js";
import { Plugins } from "./plugins/index.js";
import { Pricing } from "./pricing.js";
import { Push } from "./push.js";
import { Runner } from "./runner.js";
import { Scheduler } from "./scheduler.js";
import { Settings } from "./settings.js";
import { ThreadStore } from "./threads.js";
import { buildTools } from "./tools/index.js";
import type { ToolDef } from "./tools/types.js";
import { Vault } from "./vault.js";

/** Every long-lived service, wired once at start-up. */
export interface App {
  config: Config;
  db: Db;
  settings: Settings;
  auth: Auth;
  pairing: Pairing;
  threads: ThreadStore;
  memory: MemoryStore;
  memoryWorker: MemoryWorker;
  models: ModelService;
  pricing: Pricing;
  integrations: Integrations;
  vault: Vault;
  push: Push;
  files: Files;
  browser: BrowserService;
  actions: Actions;
  runner: Runner;
  scheduler: Scheduler;
  plugins: Plugins;
  /** Built-in tools plus those of installed plugins; rebuilt when plugins change. */
  tools: Map<string, ToolDef>;
  buildTools(): Map<string, ToolDef>;
}

export function createApp(config: Config): App {
  mkdirSync(join(config.dataDir, "files"), { recursive: true });
  const db = Db.open(config.dataDir);
  const app = { config, db } as App;
  app.settings = new Settings(db);
  app.auth = new Auth(db, config);
  app.pairing = new Pairing(db);
  app.threads = new ThreadStore(db);
  app.memory = new MemoryStore(db);
  app.integrations = new Integrations(config, db);
  app.vault = new Vault(db, config.dataDir);
  app.models = new ModelService(config, db, app.vault);
  app.pricing = new Pricing(config);
  app.push = new Push(db);
  app.files = new Files(db, config.dataDir);
  app.browser = new BrowserService(app);
  app.plugins = new Plugins(app);
  app.vault.extraSecrets = () => app.plugins.secrets();
  app.buildTools = () => buildTools(app.plugins.tools());
  app.tools = app.buildTools();
  app.actions = new Actions(app);
  app.memoryWorker = new MemoryWorker(app);
  app.runner = new Runner(app);
  app.scheduler = new Scheduler(app);
  return app;
}
