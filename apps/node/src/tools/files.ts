import { Type } from "typebox";
import { defineTool } from "./types.js";

const CHUNK = 30000;

const MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  txt: "text/plain",
  ics: "text/calendar",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

export const fileTools = [
  defineTool({
    name: "read_file",
    label: "Read file",
    description:
      "Read a file attached to this thread by id: text, code, CSV, PDF or Word (.docx). Long files come in parts; pass offset to read further.",
    parameters: Type.Object({
      file_id: Type.String(),
      offset: Type.Optional(Type.Number({ description: "Character to start from, for the next part of a long file" })),
    }),
    async run(args, ctx) {
      const info = ctx.app.files.get(args.file_id);
      if (!info || info.threadId !== ctx.thread.id) throw new Error("File not found in this thread");
      const all = ctx.app.files.readable(args.file_id) ? await ctx.app.files.text(args.file_id, Infinity) : undefined;
      if (all === undefined) throw new Error(`${info.name} has no text Vireo can read`);
      const start = Math.max(0, Math.floor(args.offset ?? 0));
      const part = all.slice(start, start + CHUNK);
      const more = start + CHUNK < all.length ? `\n\n[${all.length - start - CHUNK} more characters; read_file with offset ${start + CHUNK} for the next part]` : "";
      return { text: `${part}${more}`, source: `file ${info.name}` };
    },
  }),
  defineTool({
    name: "create_file",
    label: "Create file",
    description:
      "Create a file and attach it to your reply, where the owner can preview and download it. Use it for anything worth keeping or opening on its own: a report, plan, itinerary or draft (.md), a table (.csv), data (.json), a calendar entry (.ics), a diagram (.svg), or a self-contained page with its own styles and scripts (.html, shown as a live preview). Mention the file in your reply instead of repeating its content.",
    parameters: Type.Object({
      name: Type.String({ description: "File name with extension, e.g. trip-plan.md" }),
      content: Type.String(),
    }),
    async run(args, ctx) {
      const ext = args.name.split(".").pop()?.toLowerCase() ?? "txt";
      const mime = MIME[ext] ?? "text/plain";
      const f = ctx.app.files.save({ threadId: ctx.thread.id, name: args.name, mime, data: Buffer.from(args.content, "utf8"), origin: "produced" });
      return { text: `Created ${f.name} (${f.id}); it is attached to your reply.`, details: { fileId: f.id } };
    },
  }),
];
