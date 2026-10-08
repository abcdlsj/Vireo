import webpush from "web-push";
import type { Db } from "./db.js";
import { errorMessage, now } from "./util.js";

/**
 * Web Push for the installed PWA (works on iPhone home-screen apps and Mac).
 * VAPID keys are generated on first start and kept in the database.
 */
export interface Notification {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export class Push {
  readonly publicKey: string;
  /** Last notifications, kept for the UI and for tests. */
  readonly recent: (Notification & { at: number })[] = [];

  constructor(private readonly db: Db) {
    let keys = db.getKv<{ publicKey: string; privateKey: string }>("push.vapid");
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      db.setKv("push.vapid", keys);
    }
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(process.env.VIREO_VAPID_SUBJECT ?? "mailto:owner@vireo.local", keys.publicKey, keys.privateKey);
  }

  subscribe(sub: { endpoint: string; keys: Record<string, string> }): void {
    this.db.run(
      "INSERT INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys",
      sub.endpoint,
      JSON.stringify(sub.keys),
      now(),
    );
  }

  unsubscribe(endpoint: string): void {
    this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")?.n ?? 0;
  }

  async notify(n: Notification): Promise<void> {
    this.recent.unshift({ ...n, at: now() });
    this.recent.splice(50);
    const subs = this.db.all<{ endpoint: string; keys: string }>("SELECT endpoint, keys FROM push_subscriptions");
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(n), { TTL: 3600 });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(s.endpoint);
          else console.warn(`[push] delivery failed: ${errorMessage(err)}`);
        }
      }),
    );
  }
}
