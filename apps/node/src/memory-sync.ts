import type { App } from "./app.js";
import type { Peer } from "./peers.js";
import { errorMessage } from "./util.js";

/** Facts this node holds as copies of the home node's, by local id → home id. */
const MIRROR = "memory.mirror";
const EVERY = 10 * 60_000;

interface HomeFact {
  id: string;
  entity: string;
  entity_kind?: string;
  key: string;
  statement: string;
  kind: "semantic" | "procedural";
  valid_until: number | null;
}

/**
 * One memory for the owner across their nodes. The first node on the account
 * is home; every other node keeps a copy of home's facts, sends home what it
 * learns, and tells home what the owner takes back. What a node remembers is
 * then what all of them remember, with nothing to set up.
 */
export class MemorySync {
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private syncing = false;
  private off: (() => void) | undefined;

  constructor(private readonly app: App) {}

  start(): void {
    this.timer = setInterval(() => void this.sync(), EVERY);
    // What the owner tells this node reaches home within moments, not at the next round.
    this.off = this.app.bus.subscribe((e) => {
      if (e.type !== "memory.updated" || this.syncing) return;
      clearTimeout(this.soon);
      this.soon = setTimeout(() => void this.sync(), 5_000);
    });
    setTimeout(() => void this.sync(), 15_000).unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.off?.();
  }

  /** One round; rounds never overlap. */
  sync(): Promise<void> {
    this.running ??= this.round()
      .catch((err) => console.warn(`[memory-sync] ${errorMessage(err)}`))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async round(): Promise<void> {
    const home = await this.app.peers.home().catch(() => undefined);
    if (!home || !home.online) return;
    await this.syncWith(home);
  }

  async syncWith(home: Peer): Promise<void> {
    const mem = this.app.memory;
    const mirror = this.app.db.getKv<Record<string, string>>(MIRROR) ?? {};

    // What the owner took back here goes from home too.
    const gone = Object.entries(mirror).filter(([local]) => !mem.fact(local) || !mem.fact(local)!.current);
    if (gone.length) await this.app.peers.call(home, "forget_facts", { ids: gone.map(([, h]) => h) });

    // What this node learned goes home.
    const mirrored = new Set(Object.keys(mirror));
    const fresh = mem.list({ limit: 5000 }).filter((f) => !mirrored.has(f.id));
    if (fresh.length)
      await this.app.peers.call(home, "remember_facts", {
        facts: fresh.map((f) => ({ entity: f.entityName, entity_kind: mem.entity(f.entityId)?.kind, key: f.key, statement: f.statement, kind: f.kind, valid_until: f.validUntil })),
      });

    // Then this node holds exactly home's facts.
    const { facts } = JSON.parse(await this.app.peers.call(home, "export_memory", {})) as { facts: HomeFact[] };
    this.syncing = true;
    try {
      const next: Record<string, string> = {};
      const byHome = new Map(Object.entries(mirror).map(([l, h]) => [h, l]));
      const local = mem.list({ limit: 5000 });
      const same = (a: { entityName: string; key: string; statement: string }, b: HomeFact) =>
        a.entityName.toLowerCase() === b.entity.toLowerCase() && a.key === b.key && a.statement.trim() === b.statement.trim();
      for (const h of facts) {
        // Already here: the copy from before, or the fact this node just sent (keeping its id keeps its "Remembered" notice).
        const kept = (byHome.get(h.id) && mem.fact(byHome.get(h.id)!)?.current ? mem.fact(byHome.get(h.id)!) : undefined) ?? local.find((l) => !Object.values(next).includes(h.id) && !next[l.id] && same(l, h));
        if (kept && same(kept, h)) {
          next[kept.id] = h.id;
          continue;
        }
        const r = mem.addFact({ entity: h.entity, entityKind: h.entity_kind, key: h.key, statement: h.statement, kind: h.kind, validUntil: h.valid_until });
        next[r.fact.id] = h.id;
      }
      // Anything else here is no longer true at home.
      for (const l of mem.list({ limit: 5000 })) if (!next[l.id]) mem.delete(l.id);
      this.app.db.setKv(MIRROR, next);
    } finally {
      this.syncing = false;
    }
  }
}
