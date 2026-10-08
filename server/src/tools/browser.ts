import { Type } from "typebox";
import { formatSnapshot } from "../browser.js";
import { defineTool, untrustedBlock, type ToolContext } from "./types.js";

function snapshotOutput(ctx: ToolContext, snap: Awaited<ReturnType<ToolContext["app"]["browser"]["snapshot"]>>) {
  ctx.app.threads.addRelated(ctx.thread.id, { kind: "page", title: snap.title || snap.url, url: snap.url });
  return { text: untrustedBlock(snap.url, formatSnapshot(snap)), details: { url: snap.url } };
}

export const browserTools = [
  defineTool({
    name: "browser_open",
    label: "Open page",
    description: "Open a URL in this thread's browser tab. Returns the page text and element refs.",
    parameters: Type.Object({ url: Type.String() }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.open(ctx.thread.id, args.url));
    },
  }),
  defineTool({
    name: "browser_snapshot",
    label: "Look at page",
    description: "Re-read the current page and its element refs.",
    parameters: Type.Object({}),
    untrusted: true,
    async run(_args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.snapshot(ctx.thread.id));
    },
  }),
  defineTool({
    name: "browser_click",
    label: "Click",
    description: "Click an element by ref. Clicks that submit, pay, book or buy wait for the owner's confirmation.",
    parameters: Type.Object({
      ref: Type.String(),
      description: Type.String({ description: "What this click does, for the owner, e.g. 'Submit the booking form'" }),
    }),
    untrusted: true,
    confirm: (args, ctx) => ctx.app.browser.isConsequentialClick(ctx.thread.id, args.ref),
    summarize: (args) => args.description,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.click(ctx.thread.id, args.ref));
    },
  }),
  defineTool({
    name: "browser_type",
    label: "Type",
    description:
      "Type into a field by ref. Use {{username}} and {{password}} to fill stored credentials for the current site. Set submit=true to press Enter (waits for confirmation).",
    parameters: Type.Object({
      ref: Type.String(),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    untrusted: true,
    confirm: (args) => Boolean(args.submit),
    summarize: (args) => `Type into the page and press Enter to submit`,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.type(ctx.thread.id, args.ref, args.text, Boolean(args.submit)));
    },
  }),
  defineTool({
    name: "browser_select",
    label: "Choose option",
    description: "Choose an option in a select element by ref.",
    parameters: Type.Object({ ref: Type.String(), value: Type.String() }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.select(ctx.thread.id, args.ref, args.value));
    },
  }),
  defineTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description: "Take a screenshot of the current page and attach it to the thread.",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      const png = await ctx.app.browser.screenshot(ctx.thread.id);
      const file = ctx.app.files.save({ threadId: ctx.thread.id, name: `screenshot-${Date.now()}.png`, mime: "image/png", data: png, origin: "produced" });
      return { text: `Screenshot attached to the thread (${file.id}).`, details: { fileId: file.id } };
    },
  }),
  defineTool({
    name: "list_credentials",
    label: "List sign-ins",
    description: "List sites with stored sign-in credentials (domains and usernames only; passwords are never shown).",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      const list = ctx.app.vault.list();
      return {
        text: list.length
          ? `${list.map((c) => `- ${c.domain} (user: ${c.username})`).join("\n")}\nType {{username}} and {{password}} into the sign-in fields to use them.`
          : "No stored credentials. The owner can add them in Settings → Sign-ins.",
      };
    },
  }),
];
