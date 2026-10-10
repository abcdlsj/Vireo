import { Type } from "typebox";
import { defineTool } from "./types.js";

export const fileTools = [
  defineTool({
    name: "read_file",
    label: "Read file",
    description: "Read a text file attached to this thread by id.",
    parameters: Type.Object({ file_id: Type.String() }),
    async run(args, ctx) {
      const info = ctx.app.files.get(args.file_id);
      if (!info || info.threadId !== ctx.thread.id) throw new Error("File not found in this thread");
      const text = ctx.app.files.text(args.file_id);
      if (text === undefined) throw new Error(`${info.name} is not a text file`);
      return { text, source: `file ${info.name}` };
    },
  }),
  defineTool({
    name: "create_file",
    label: "Create file",
    description: "Create a file (markdown, CSV, text, JSON…) and attach it to this thread for the owner to download.",
    parameters: Type.Object({
      name: Type.String({ description: "File name with extension, e.g. trip-plan.md" }),
      content: Type.String(),
    }),
    async run(args, ctx) {
      const ext = args.name.split(".").pop()?.toLowerCase() ?? "txt";
      const mime =
        { md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", txt: "text/plain", ics: "text/calendar" }[ext] ??
        "text/plain";
      const f = ctx.app.files.save({ threadId: ctx.thread.id, name: args.name, mime, data: Buffer.from(args.content, "utf8"), origin: "produced" });
      return { text: `Created ${f.name} (${f.id}); it is attached to the thread.`, details: { fileId: f.id } };
    },
  }),
];
