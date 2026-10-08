import { Type } from "typebox";
import type { Fact } from "../memory.js";
import { formatDate } from "../util.js";
import { defineTool } from "./types.js";

export function describeFact(f: Fact, tz?: string): string {
  const source = f.sourceThreadTitle ? `thread "${f.sourceThreadTitle}" (${f.sourceThreadId})` : "owner edit";
  const status = f.current
    ? ""
    : f.invalidatedAt
      ? ` [replaced on ${formatDate(f.invalidatedAt, tz)}]`
      : ` [expired on ${formatDate(f.validUntil!, tz)}]`;
  return `- [${f.id}] (${f.entityName} · ${f.key}) ${f.statement} — since ${formatDate(f.validFrom, tz)}; source: ${source}${status}`;
}

export const memoryTools = [
  defineTool({
    name: "recall_memory",
    label: "Recall memory",
    description:
      "Search long-term memory about the owner, people, places and projects. Returns facts with their sources. Use include_history to see replaced facts, or as_of (ISO date) to see what was true at a time.",
    parameters: Type.Object({
      query: Type.String({ description: "Who or what to recall, e.g. 'Anna' or 'home address'" }),
      include_history: Type.Optional(Type.Boolean()),
      as_of: Type.Optional(Type.String({ description: "ISO date; facts valid at that time" })),
    }),
    async run(args, ctx) {
      const tz = ctx.app.settings.get().timezone;
      const facts = args.as_of
        ? ctx.app.memory.asOf(Date.parse(args.as_of), args.query)
        : ctx.app.memory.list({ query: args.query, includeHistory: args.include_history, limit: 30 });
      const episodes = ctx.app.memory.episodes({ query: args.query, limit: 5 });
      const lines = [
        facts.length ? `Facts (${facts.length}):\n${facts.map((f) => describeFact(f, tz)).join("\n")}` : "No matching facts in memory.",
      ];
      if (episodes.length) {
        lines.push(
          `Related episodes:\n${episodes.map((e) => `- ${formatDate(e.occurredAt, tz)}: ${e.content.slice(0, 200)}${e.threadId ? ` (thread ${e.threadId})` : ""}`).join("\n")}`,
        );
      }
      return { text: lines.join("\n\n"), details: { count: facts.length } };
    },
  }),
  defineTool({
    name: "remember",
    label: "Remember",
    description:
      "Store a lasting fact, preference or decision in long-term memory. Use a stable key per slot (e.g. 'home_address', 'preference.airline', 'birthday') so a newer value replaces the old one. Only store settled facts, never task progress.",
    parameters: Type.Object({
      statement: Type.String({ description: "The fact as a full sentence, e.g. 'Owner prefers aisle seats on flights'" }),
      key: Type.String({ description: "Stable slot name, e.g. 'preference.seat'" }),
      about: Type.Optional(Type.String({ description: "Entity the fact is about; omit for the owner" })),
      about_kind: Type.Optional(Type.String({ description: "person | place | project | org | thing" })),
      valid_until: Type.Optional(Type.String({ description: "ISO date after which the fact is no longer current" })),
      procedural: Type.Optional(Type.Boolean({ description: "True for how-to knowledge" })),
    }),
    writesMemory: true,
    async run(args, ctx) {
      const episodeId = ctx.app.memory.addEpisode({ threadId: ctx.thread.id, source: "tool", content: `Vireo remembered: ${args.statement}` });
      const r = ctx.app.memory.addFact({
        entity: args.about,
        entityKind: args.about_kind,
        key: args.key,
        statement: args.statement,
        kind: args.procedural ? "procedural" : "semantic",
        validUntil: args.valid_until ? Date.parse(args.valid_until) : null,
        sourceThreadId: ctx.thread.id,
        episodeId,
      });
      const replaced = r.superseded.map((f) => `"${f.statement}"`).join(", ");
      return {
        text: r.unchanged
          ? `Already known: ${r.fact.statement}`
          : `Remembered [${r.fact.id}]: ${r.fact.statement}${replaced ? `. Replaced: ${replaced}` : ""}`,
        details: { factId: r.fact.id },
      };
    },
  }),
  defineTool({
    name: "forget_memory",
    label: "Forget",
    description: "Delete a fact from long-term memory by id (from recall_memory). Requires the owner's confirmation.",
    parameters: Type.Object({ fact_id: Type.String() }),
    confirm: () => true,
    summarize: (args) => `Delete memory ${args.fact_id}`,
    async run(args, ctx) {
      const f = ctx.app.memory.fact(args.fact_id);
      if (!f) throw new Error(`No memory with id ${args.fact_id}`);
      ctx.app.memory.delete(args.fact_id);
      return { text: `Deleted: ${f.statement}` };
    },
  }),
];
