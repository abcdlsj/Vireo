import type { App } from "./app.js";
import { OVERVIEW_ID, messageText } from "./threads.js";
import { errorMessage, formatDate, newId, now } from "./util.js";

interface ExtractedFact {
  entity?: string;
  entity_kind?: string;
  key?: string;
  statement?: string;
  valid_until?: string | null;
  procedural?: boolean;
}

const EXTRACT_SYSTEM = [
  "You maintain the long-term memory of a personal assistant for one person, the owner.",
  "From the conversation below, extract only lasting facts about the owner and the people, places, projects and organisations in their life: preferences, personal details (addresses, birthdays, family, work), relationships, decisions, commitments and bookings with dates, and how the owner wants kinds of tasks done.",
  "Do NOT extract: the requests themselves, transient task progress, things that are uncertain, generic knowledge, or anything the assistant said that the owner did not confirm.",
  "For each fact return:",
  '- entity: "owner" or the name of the person/place/project it is about',
  "- entity_kind: owner | person | place | project | org | thing",
  "- key: a stable snake_case slot such as home_address, birthday, preference.airline, preference.seat, employer. Reuse an existing key from the list when the new fact updates that slot, so the old value is replaced.",
  "- statement: one full sentence in the owner's language, e.g. \"Owner prefers aisle seats on flights\"",
  "- valid_until: ISO date when the fact naturally stops being current (e.g. the day after a trip), otherwise null",
  "- procedural: true when it describes how the owner wants a kind of task done",
  'Reply with JSON only: {"facts": [...]}. Return {"facts": []} when there is nothing lasting.',
].join("\n");

/**
 * Keeps long-term memory up to date in the background on the cheaper model:
 * after each run it extracts lasting facts from what the owner said, and
 * when a thread is done it distils the conclusions (M4).
 */
export class MemoryWorker {
  private timers = new Map<string, NodeJS.Timeout>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly app: App) {}

  afterRun(threadId: string): void {
    clearTimeout(this.timers.get(threadId));
    this.timers.set(
      threadId,
      setTimeout(() => {
        this.timers.delete(threadId);
        this.enqueue(() => this.extractNew(threadId));
      }, 500),
    );
  }

  /** Waits for pending memory work (used by tests and on shutdown). */
  async flush(): Promise<void> {
    for (const [threadId, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(threadId);
      this.enqueue(() => this.extractNew(threadId));
    }
    await this.queue;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((err) => console.warn(`[memory] ${errorMessage(err)}`));
    return this.queue;
  }

  private async extractNew(threadId: string): Promise<void> {
    const thread = this.app.threads.get(threadId);
    if (!thread || thread.temporary) return;
    const cursorKey = `memory.cursor.${threadId}`;
    const cursor = this.app.db.getKv<number>(cursorKey) ?? 0;
    const msgs = this.app.threads.messages(threadId).filter((m) => m.id > cursor && m.role === "user" && m.agent !== "vireo");
    if (msgs.length === 0) return;
    const ownerText = msgs.map((m) => messageText(m.body)).filter(Boolean).join("\n");
    this.app.db.setKv(cursorKey, Math.max(...msgs.map((m) => m.id)));
    if (!ownerText.trim()) return;
    const episodeId = this.app.memory.addEpisode({ threadId, source: "message", content: `Owner said in "${thread.title}": ${ownerText}` });
    const recent = this.app.threads.transcript(threadId, { maxChars: 3000 });
    await this.extract(threadId, `Recent conversation for context:\n${recent}\n\nNew messages from the owner (extract from these):\n${ownerText}`, episodeId);
  }

  private async extract(threadId: string, material: string, episodeId: string): Promise<number> {
    const owner = this.app.memory.profile(60);
    const known = this.app.memory.list({ limit: 60 });
    const keyList = [...new Set([...owner, ...known].map((f) => `${f.entityName}: ${f.key} = ${f.statement}`))].slice(0, 80);
    const result = await this.app.models.completeJson<{ facts: ExtractedFact[] }>({
      task: "memory_extract",
      threadId,
      system: EXTRACT_SYSTEM,
      prompt: `Existing facts (entity: key = statement):\n${keyList.join("\n") || "(none)"}\n\n${material}`,
      maxTokens: 1500,
    });
    let added = 0;
    for (const f of result?.facts ?? []) {
      if (!f.statement || typeof f.statement !== "string") continue;
      const validUntil = f.valid_until ? Date.parse(f.valid_until) : NaN;
      const r = this.app.memory.addFact({
        entity: f.entity,
        entityKind: f.entity_kind,
        key: f.key,
        statement: f.statement,
        kind: f.procedural ? "procedural" : "semantic",
        validUntil: Number.isNaN(validUntil) ? null : validUntil,
        sourceThreadId: threadId === OVERVIEW_ID ? OVERVIEW_ID : threadId,
        episodeId,
      });
      if (!r.unchanged) added += 1;
    }
    return added;
  }

  /** When a thread is done: record the episode, keep the conclusions, maybe propose a procedure. */
  async distill(threadId: string, summary: string): Promise<void> {
    await this.enqueue(async () => {
      const thread = this.app.threads.get(threadId);
      if (!thread || thread.temporary) return;
      await this.extractNew(threadId);
      const tz = this.app.settings.get().timezone;
      const episodeId = this.app.memory.addEpisode({
        threadId,
        source: "thread_summary",
        content: `${formatDate(now(), tz)}: finished "${thread.title}" — ${summary}`,
      });
      const transcript = this.app.threads.transcript(threadId, { maxChars: 12000 });
      await this.extract(
        threadId,
        `This matter is now finished. Keep only its lasting conclusions (decisions, bookings and their dates, outcomes, preferences learned).\nOutcome: ${summary}\n\nConversation:\n${transcript}`,
        episodeId,
      );
      await this.maybeProposeProcedure(threadId, transcript);
    });
  }

  private async maybeProposeProcedure(threadId: string, transcript: string): Promise<void> {
    const toolCount = this.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls WHERE thread_id = ?", threadId)?.n ?? 0;
    if (toolCount < 3) return;
    const existing = this.app.db.all<{ name: string; description: string }>("SELECT name, description FROM procedures WHERE status != 'rejected'");
    const r = await this.app.models.completeJson<{ procedure: { name: string; description: string; steps: string } | null }>({
      task: "procedure_proposal",
      threadId,
      system: [
        "Decide whether this finished matter is a new, repeatable kind of task worth a reusable procedure for the owner (for example booking flights, scheduling a dentist visit, filing an expense).",
        "If an existing procedure already covers it, or the task is one-off, return {\"procedure\": null}.",
        'Otherwise return {"procedure": {"name": "...", "description": "when to use it", "steps": "markdown steps including the owner\'s preferences"}}. JSON only.',
      ].join("\n"),
      prompt: `Existing procedures:\n${existing.map((p) => `- ${p.name}: ${p.description}`).join("\n") || "(none)"}\n\nConversation:\n${transcript}`,
      maxTokens: 800,
    });
    const p = r?.procedure;
    if (!p?.name || !p.steps) return;
    const id = newId("proc");
    this.app.db.run(
      "INSERT INTO procedures (id, name, description, steps, status, source_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)",
      id,
      p.name,
      p.description ?? "",
      p.steps,
      threadId,
      now(),
      now(),
    );
    this.app.threads.addNotice(threadId, "procedure", `Proposed procedure "${p.name}"`, { data: { procedureId: id } });
  }
}
