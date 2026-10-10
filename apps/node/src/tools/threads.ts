import { Type } from "typebox";
import { OVERVIEW_ID } from "../threads.js";
import { formatDate, now } from "../util.js";
import { defineTool } from "./types.js";

export const threadTools = [
  defineTool({
    name: "find_threads",
    label: "Find threads",
    description: "Find earlier matters (including finished threads) by keywords, e.g. when the owner says 'like the Shanghai trip'.",
    parameters: Type.Object({ query: Type.String() }),
    async run(args, ctx) {
      const hits = ctx.app.threads.search(args.query).filter((h) => h.thread.id !== ctx.thread.id);
      if (hits.length === 0) return { text: "No matching threads." };
      const tz = ctx.app.settings.get().timezone;
      return {
        text: hits
          .map(
            (h) =>
              `- ${h.thread.id}: "${h.thread.title}" (${h.thread.state === "done" ? `done ${formatDate(h.thread.doneAt ?? h.thread.updatedAt, tz)}` : "open"})${h.thread.summary ? ` — ${h.thread.summary}` : h.snippet ? ` — ${h.snippet.slice(0, 160)}` : ""}`,
          )
          .join("\n"),
      };
    },
  }),
  defineTool({
    name: "read_thread",
    label: "Read thread",
    description: "Read the summary and recent conversation of another thread by id.",
    parameters: Type.Object({ thread_id: Type.String() }),
    async run(args, ctx) {
      const t = ctx.app.threads.get(args.thread_id);
      if (!t || t.temporary) throw new Error("Thread not found");
      return {
        text: `Thread "${t.title}" (${t.state})\nSummary: ${t.summary ?? "(none)"}\n\n${ctx.app.threads.transcript(t.id, { maxChars: 6000 })}`,
      };
    },
  }),
  defineTool({
    name: "open_thread",
    label: "Open thread",
    description:
      "Open a new thread for a matter that needs several turns, and start working on it there. Use from Overview instead of carrying a multi-step matter in Overview.",
    parameters: Type.Object({
      title: Type.String({ description: "Short name for the matter" }),
      brief: Type.String({ description: "The owner's request, restated fully so the new thread can start without this conversation" }),
    }),
    async run(args, ctx) {
      const t = ctx.app.threads.create({ title: args.title, origin: { kind: "overview", from: ctx.thread.id } });
      ctx.app.runner.send(t.id, args.brief, { source: "vireo" });
      ctx.app.threads.addNotice(ctx.thread.id, "thread_link", `Opened thread "${args.title}"`, { data: { threadId: t.id } });
      return { text: `Opened thread ${t.id} "${args.title}" and started work there. Tell the owner briefly and link it as [${args.title}](#thread/${t.id}).` };
    },
  }),
  defineTool({
    name: "set_status",
    label: "Set status",
    description: "Set this thread's one-line status shown in the thread list, e.g. 'Waiting for Anna to reply'.",
    parameters: Type.Object({ status: Type.String() }),
    async run(args, ctx) {
      ctx.app.threads.setStatus(ctx.thread.id, args.status);
      ctx.app.db.setKv(`thread.status_set.${ctx.thread.id}`, now());
      return { text: "Status updated." };
    },
  }),
  defineTool({
    name: "complete_thread",
    label: "Complete thread",
    description: "Mark this matter as done when the owner says it is finished, or right after you fully answered a one-off question and nothing is left to do or watch. Lasting conclusions are kept in memory.",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      if (ctx.thread.id === OVERVIEW_ID) throw new Error("Overview cannot be completed");
      // Run after the current turn so the closing reply is part of the summary.
      setTimeout(() => void ctx.app.lifecycle.complete(ctx.thread.id), 0);
      return { text: "The thread will be marked done after this reply." };
    },
  }),
  defineTool({
    name: "set_reminder",
    label: "Set reminder",
    description:
      "Remind the owner at a time (kind 'reminder'), or come back to this thread at a time to follow up on something waiting on someone else (kind 'follow_up').",
    parameters: Type.Object({
      at: Type.String({ description: "ISO 8601 date-time with offset" }),
      text: Type.String({ description: "What to remind about or check" }),
      kind: Type.Optional(Type.Union([Type.Literal("reminder"), Type.Literal("follow_up")])),
    }),
    async run(args, ctx) {
      const due = Date.parse(args.at);
      if (Number.isNaN(due)) throw new Error("Invalid date-time");
      const id = ctx.app.reminders.add({ threadId: ctx.thread.id, kind: args.kind ?? "reminder", text: args.text, dueAt: due });
      return { text: `Reminder ${id} set for ${formatDate(due, ctx.app.settings.get().timezone)}.` };
    },
  }),
  defineTool({
    name: "list_reminders",
    label: "List reminders",
    description: "List scheduled reminders and follow-ups.",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      const rows = ctx.app.reminders.scheduled();
      const tz = ctx.app.settings.get().timezone;
      return { text: rows.length ? rows.map((r) => `- ${r.id} ${formatDate(r.dueAt, tz)} [${r.kind}] ${r.text}`).join("\n") : "No reminders scheduled." };
    },
  }),
  defineTool({
    name: "cancel_reminder",
    label: "Cancel reminder",
    description: "Cancel a scheduled reminder by id.",
    parameters: Type.Object({ id: Type.String() }),
    async run(args, ctx) {
      if (!ctx.app.reminders.cancel(args.id)) throw new Error("No scheduled reminder with that id");
      return { text: "Reminder cancelled." };
    },
  }),
  defineTool({
    name: "propose_procedure",
    label: "Propose procedure",
    description:
      "After completing a new kind of task, propose a reusable procedure (how this kind of task is done for the owner). It is only used after the owner approves it.",
    parameters: Type.Object({
      name: Type.String(),
      description: Type.String({ description: "When to use it" }),
      steps: Type.String({ description: "Markdown steps, including the owner's preferences" }),
    }),
    writesMemory: true,
    async run(args, ctx) {
      const id = ctx.app.procedures.propose({ name: args.name, description: args.description, steps: args.steps, threadId: ctx.thread.id });
      ctx.app.threads.addNotice(ctx.thread.id, "procedure", `Proposed procedure "${args.name}"`, { data: { procedureId: id } });
      return { text: `Proposed procedure ${id}. The owner can approve it from the card in this thread.` };
    },
  }),
];
