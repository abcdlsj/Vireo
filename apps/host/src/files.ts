import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Bus } from "./bus.js";
import type { Db } from "./db.js";
import { newId, now } from "./util.js";

export interface FileInfo {
  id: string;
  threadId: string | null;
  name: string;
  mime: string;
  size: number;
  origin: "upload" | "produced";
  createdAt: number;
}

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv))/;

/** Files owners attach to threads and files Vireo produces (C9). */
export class Files {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly bus: Bus,
  ) {}

  save(opts: { threadId: string | null; name: string; mime: string; data: Buffer; origin: "upload" | "produced" }): FileInfo {
    const id = newId("file");
    const safeExt = extname(opts.name).replace(/[^a-z0-9.]/gi, "").slice(0, 10);
    const path = join(this.dataDir, "files", `${id}${safeExt}`);
    writeFileSync(path, opts.data);
    this.db.run(
      "INSERT INTO files (id, thread_id, name, mime, size, path, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      opts.threadId,
      opts.name.slice(0, 200),
      opts.mime || "application/octet-stream",
      opts.data.length,
      path,
      opts.origin,
      now(),
    );
    if (opts.threadId) {
      this.db.run(
        "INSERT INTO related (thread_id, kind, title, ref, created_at) VALUES (?, ?, ?, ?, ?)",
        opts.threadId,
        opts.mime.startsWith("image/") && opts.origin === "produced" ? "screenshot" : "file",
        opts.name,
        id,
        now(),
      );
      this.bus.publish({ type: "thread.updated", threadId: opts.threadId });
    }
    return this.get(id)!;
  }

  get(id: string): FileInfo | undefined {
    const r = this.db.get<{ id: string; thread_id: string | null; name: string; mime: string; size: number; origin: "upload" | "produced"; created_at: number }>(
      "SELECT * FROM files WHERE id = ?",
      id,
    );
    return r ? { id: r.id, threadId: r.thread_id, name: r.name, mime: r.mime, size: r.size, origin: r.origin, createdAt: r.created_at } : undefined;
  }

  read(id: string): { info: FileInfo; data: Buffer } | undefined {
    const row = this.db.get<{ path: string }>("SELECT path FROM files WHERE id = ?", id);
    const info = this.get(id);
    if (!row || !info) return undefined;
    return { info, data: readFileSync(row.path) };
  }

  /** Text content of a file, when it is text-like. */
  text(id: string, max = 30000): string | undefined {
    const f = this.read(id);
    if (!f) return undefined;
    if (!TEXT_MIME.test(f.info.mime) && !/\.(md|txt|csv|json|ya?ml|log|html?)$/i.test(f.info.name)) return undefined;
    return f.data.toString("utf8").slice(0, max);
  }

  forThread(threadId: string): FileInfo[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM files WHERE thread_id = ? ORDER BY created_at", threadId)
      .map((r) => this.get(r.id)!)
      .filter(Boolean);
  }

  delete(id: string): void {
    const row = this.db.get<{ path: string }>("SELECT path FROM files WHERE id = ?", id);
    if (!row) return;
    try {
      unlinkSync(row.path);
    } catch {
      // already gone
    }
    this.db.run("DELETE FROM files WHERE id = ?", id);
  }
}
