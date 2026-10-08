import { Type } from "typebox";
import { formatSnapshot } from "../browser.js";
import { defineTool, untrustedBlock, type ToolContext, type ToolDef } from "./types.js";

function snapshotOutput(ctx: ToolContext, snap: Awaited<ReturnType<ToolContext["app"]["browser"]["snapshot"]>>) {
  ctx.app.threads.addRelated(ctx.thread.id, { kind: "page", title: snap.title || snap.url, url: snap.url });
  return { text: untrustedBlock(snap.url, formatSnapshot(snap)), details: { url: snap.url } };
}

const Ref = Type.String({ description: "Element ref from the latest snapshot, e.g. e12 or f1e3" });

const tools = [
  defineTool({
    name: "browser_open",
    label: "Open page",
    description: "Open a URL in this thread's browser. Returns the page as an accessibility tree with element refs.",
    parameters: Type.Object({
      url: Type.String(),
      new_tab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of the current one" })),
    }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.open(ctx.thread.id, args.url, Boolean(args.new_tab)));
    },
  }),
  defineTool({
    name: "browser_snapshot",
    label: "Look at page",
    description: "Re-read the current page and its element refs. Refs from older snapshots may stop working after the page changes.",
    parameters: Type.Object({}),
    untrusted: true,
    async run(_args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.snapshot(ctx.thread.id));
    },
  }),
  defineTool({
    name: "browser_read",
    label: "Read page",
    description: "Return the visible text of the current page, for reading articles, prices or long result lists.",
    parameters: Type.Object({}),
    untrusted: true,
    async run(_args, ctx) {
      const r = await ctx.app.browser.read(ctx.thread.id);
      return { text: untrustedBlock(r.url, `URL: ${r.url}\nTitle: ${r.title}\n\n${r.text}`), details: { url: r.url } };
    },
  }),
  defineTool({
    name: "browser_click",
    label: "Click",
    description: "Click an element by ref. Clicks that submit, pay, book or buy wait for the owner's confirmation.",
    parameters: Type.Object({
      ref: Ref,
      description: Type.String({ description: "What this click does, for the owner, e.g. 'Submit the booking form'" }),
      double: Type.Optional(Type.Boolean()),
    }),
    untrusted: true,
    confirm: (args, ctx) => ctx.app.browser.isConsequentialClick(ctx.thread.id, args.ref),
    summarize: (args) => args.description,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.click(ctx.thread.id, args.ref, Boolean(args.double)));
    },
  }),
  defineTool({
    name: "browser_type",
    label: "Type",
    description:
      "Replace the text of a field by ref. Use {{username}} and {{password}} to fill stored credentials for the current site. Set submit=true to press Enter (submitting a non-search form waits for confirmation). Set slowly=true for autocomplete fields that need real key presses.",
    parameters: Type.Object({
      ref: Ref,
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
      slowly: Type.Optional(Type.Boolean()),
    }),
    untrusted: true,
    confirm: (args, ctx) => (args.submit ? ctx.app.browser.isConsequentialSubmit(ctx.thread.id, args.ref) : false),
    summarize: () => `Type into the page and press Enter to submit`,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.type(ctx.thread.id, args.ref, args.text, Boolean(args.submit), Boolean(args.slowly)));
    },
  }),
  defineTool({
    name: "browser_press",
    label: "Press key",
    description: "Press a key or shortcut, e.g. Enter, Escape, Tab, ArrowDown, PageDown. Targets the element by ref, or the focused element when ref is omitted.",
    parameters: Type.Object({ key: Type.String(), ref: Type.Optional(Ref) }),
    untrusted: true,
    confirm: (args, ctx) => (/^enter$/i.test(args.key) ? ctx.app.browser.isConsequentialSubmit(ctx.thread.id, args.ref) : false),
    summarize: (args) => `Press ${args.key} to submit the form`,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.press(ctx.thread.id, args.key, args.ref));
    },
  }),
  defineTool({
    name: "browser_select",
    label: "Choose option",
    description: "Choose one or more options in a native select element (combobox) by ref. For custom dropdowns, click the dropdown and then the option instead.",
    parameters: Type.Object({ ref: Ref, values: Type.Array(Type.String(), { minItems: 1 }) }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.select(ctx.thread.id, args.ref, args.values));
    },
  }),
  defineTool({
    name: "browser_check",
    label: "Tick box",
    description: "Check or uncheck a checkbox, radio button or switch by ref.",
    parameters: Type.Object({ ref: Ref, checked: Type.Boolean() }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.check(ctx.thread.id, args.ref, args.checked));
    },
  }),
  defineTool({
    name: "browser_hover",
    label: "Hover",
    description: "Move the mouse over an element by ref, to open hover menus or tooltips.",
    parameters: Type.Object({ ref: Ref }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.hover(ctx.thread.id, args.ref));
    },
  }),
  defineTool({
    name: "browser_scroll",
    label: "Scroll",
    description: "Scroll the page up or down to load more content, or scroll an element into view by ref.",
    parameters: Type.Object({
      direction: Type.Optional(Type.Union([Type.Literal("down"), Type.Literal("up")])),
      ref: Type.Optional(Ref),
    }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.scroll(ctx.thread.id, args.direction ?? "down", args.ref));
    },
  }),
  defineTool({
    name: "browser_wait",
    label: "Wait",
    description: "Wait until some text appears on the page, or for a number of seconds (max 20), when results are still loading.",
    parameters: Type.Object({ text: Type.Optional(Type.String()), seconds: Type.Optional(Type.Number({ minimum: 0.5, maximum: 20 })) }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.wait(ctx.thread.id, args));
    },
  }),
  defineTool({
    name: "browser_back",
    label: "Go back",
    description: "Go back (or forward) in the current tab's history.",
    parameters: Type.Object({ forward: Type.Optional(Type.Boolean()) }),
    untrusted: true,
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.history(ctx.thread.id, args.forward ? "forward" : "back"));
    },
  }),
  defineTool({
    name: "browser_tab",
    label: "Switch tab",
    description: "Switch to or close one of this thread's tabs by index (listed in the snapshot). Links that open a new tab switch to it automatically.",
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ minimum: 0 })),
      close: Type.Optional(Type.Boolean({ description: "Close the tab (the current one when index is omitted)" })),
    }),
    untrusted: true,
    async run(args, ctx) {
      const b = ctx.app.browser;
      if (args.close) return snapshotOutput(ctx, await b.closeTab(ctx.thread.id, args.index));
      if (args.index === undefined) return snapshotOutput(ctx, await b.snapshot(ctx.thread.id));
      return snapshotOutput(ctx, await b.selectTab(ctx.thread.id, args.index));
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

/** While the owner has taken over the browser, the agent's browser tools wait for it to be handed back. */
function waitsForOwner(t: ToolDef): ToolDef {
  if (!t.name.startsWith("browser_")) return t;
  return {
    ...t,
    async run(args, ctx) {
      if (ctx.app.browser.isControlled(ctx.thread.id)) ctx.app.threads.setStatus(ctx.thread.id, "Waiting for you to hand back the browser");
      const waited = await ctx.app.browser.waitForOwner(ctx.thread.id, ctx.signal);
      if (waited) ctx.app.threads.setStatus(ctx.thread.id, `${t.label}…`);
      const out = await t.run(args, ctx);
      return waited ? { ...out, text: `The owner used the browser and has handed it back; the page may have changed.\n\n${out.text}` } : out;
    },
  };
}

export const browserTools = (tools as ToolDef[]).map(waitsForOwner);
