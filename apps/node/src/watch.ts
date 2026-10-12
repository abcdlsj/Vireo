import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { App } from "./app.js";
import { errorMessage } from "./util.js";
import { VERSION } from "./version.js";

/** A node offline this long is worth telling the owner about. */
const OFFLINE_AFTER = 30 * 60_000;
const CHECK_PEERS = 5 * 60_000;
const CHECK_UPDATES = 6 * 60 * 60_000;

/**
 * Tells the owner when one of their other nodes has been offline for a while,
 * and when it is back. Only the home node (the first on the account) watches,
 * so the owner hears it once.
 */
export class PeerWatch {
  private timer: NodeJS.Timeout | undefined;
  private readonly offlineSince = new Map<string, number>();
  private readonly told = new Set<string>();

  constructor(private readonly app: App) {}

  start(): void {
    this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_PEERS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async check(now = Date.now()): Promise<void> {
    const peers = await this.app.peers.list(true);
    if (!peers.length || (await this.app.peers.home())) return;
    for (const p of peers) {
      if (p.online) {
        this.offlineSince.delete(p.id);
        if (this.told.delete(p.id)) void this.app.push.notify({ title: `${p.name} is back`, body: "Vireo can reach it again.", url: "/#settings/nodes", tag: `node-${p.id}` });
        continue;
      }
      const since = this.offlineSince.get(p.id) ?? now;
      this.offlineSince.set(p.id, since);
      if (!this.told.has(p.id) && now - since >= OFFLINE_AFTER) {
        this.told.add(p.id);
        void this.app.push.notify({
          title: `${p.name} is offline`,
          body: `Not reachable for ${Math.round((now - since) / 60_000)} minutes. Is the machine asleep, or did Vireo stop there?`,
          url: "/#settings/nodes",
          tag: `node-${p.id}`,
        });
      }
    }
  }
}

/** True when version a is newer than b (x.y.z). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/**
 * A node run as a service keeps itself up to date: it installs a newer
 * release into its own copy, waits for running work to finish, and exits so
 * launchd or systemd starts the new one. VIREO_AUTO_UPDATE=off turns it off.
 */
export class AutoUpdate {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly app: App) {}

  /** Only a node the service started (it runs from the copy under the data directory). */
  enabled(): boolean {
    return process.env.VIREO_SERVICE === "1" && process.env.VIREO_AUTO_UPDATE !== "off";
  }

  start(): void {
    if (!this.enabled()) return;
    setTimeout(() => void this.check(), 5 * 60_000).unref();
    this.timer = setInterval(() => void this.check(), CHECK_UPDATES);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async check(): Promise<void> {
    try {
      const res = await fetch("https://registry.npmjs.org/@abcdlsj/vireo-node/latest", { signal: AbortSignal.timeout(20_000) });
      const { version } = (await res.json()) as { version?: string };
      if (!version || !newer(version, VERSION)) return;
      const appDir = join(this.app.config.dataDir, "app");
      const npm = join(dirname(process.execPath), "npm");
      await new Promise<void>((ok, fail) =>
        execFile(npm, ["install", "--prefix", appDir, "--no-audit", "--no-fund", "--loglevel=error", "--omit=dev", `@abcdlsj/vireo-node@${version}`], { timeout: 10 * 60_000 }, (err) => (err ? fail(err) : ok())),
      );
      console.log(`[update] Installed ${version}; restarting once running work is done.`);
      await this.app.runner.idle();
      process.kill(process.pid, "SIGTERM");
    } catch (err) {
      console.warn(`[update] ${errorMessage(err)}`);
    }
  }
}
