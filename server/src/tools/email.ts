import { Type } from "typebox";
import { truncate } from "../util.js";
import { defineTool, untrustedBlock, type ToolContext } from "./types.js";

function mail(ctx: ToolContext) {
  const m = ctx.app.integrations.mail();
  if (!m) throw new Error("Email is not connected. Ask the owner to connect Google in Settings.");
  return m;
}

export const emailTools = [
  defineTool({
    name: "search_email",
    label: "Search email",
    description: "Search the owner's email (Gmail query syntax, e.g. 'from:anna newer_than:7d' or 'is:unread').",
    parameters: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })) }),
    untrusted: true,
    async run(args, ctx) {
      const results = await mail(ctx).search(args.query, args.max_results ?? 10);
      if (results.length === 0) return { text: "No matching email." };
      return {
        text: untrustedBlock(
          "email search",
          results.map((m) => `- ${m.id} | ${m.date} | from ${m.from} | "${m.subject}" ${m.unread ? "[unread]" : ""}\n  ${m.snippet}`).join("\n"),
        ),
      };
    },
  }),
  defineTool({
    name: "read_email",
    label: "Read email",
    description: "Read one email by id.",
    parameters: Type.Object({ id: Type.String() }),
    untrusted: true,
    async run(args, ctx) {
      const m = await mail(ctx).get(args.id);
      ctx.app.threads.addRelated(ctx.thread.id, { kind: "email", title: m.subject || "(no subject)", ref: m.id, data: { from: m.from, date: m.date } });
      return {
        text: untrustedBlock(`email from ${m.from}`, `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${truncate(m.body, 12000)}`),
      };
    },
  }),
  defineTool({
    name: "draft_email",
    label: "Save draft",
    description: "Save an email draft in the owner's mailbox without sending it.",
    parameters: Type.Object({
      to: Type.String(),
      subject: Type.String(),
      body: Type.String(),
      cc: Type.Optional(Type.String()),
      reply_to_id: Type.Optional(Type.String({ description: "Id of the email being replied to" })),
    }),
    async run(args, ctx) {
      const r = await mail(ctx).createDraft({ to: args.to, subject: args.subject, body: args.body, cc: args.cc, replyToId: args.reply_to_id });
      return { text: `Draft saved (${r.id}).` };
    },
  }),
  defineTool({
    name: "send_email",
    label: "Send email",
    description: "Send an email. Always waits for the owner's confirmation; the owner may edit it on the card.",
    parameters: Type.Object({
      to: Type.String(),
      subject: Type.String(),
      body: Type.String(),
      cc: Type.Optional(Type.String()),
      reply_to_id: Type.Optional(Type.String({ description: "Id of the email being replied to" })),
    }),
    confirm: () => true,
    summarize: (args) => `Send email to ${args.to}: "${args.subject}"`,
    async run(args, ctx) {
      const r = await mail(ctx).send({ to: args.to, subject: args.subject, body: args.body, cc: args.cc, replyToId: args.reply_to_id });
      ctx.app.threads.addRelated(ctx.thread.id, { kind: "email", title: `Sent: ${args.subject}`, ref: r.id, data: { to: args.to } });
      return { text: `Email sent to ${args.to} (${r.id}).` };
    },
  }),
];
