import { Type } from "typebox";
import { formatSnapshot } from "../browser.js";
import { defineTool, type ToolContext, type ToolDef } from "./types.js";

function snapshotOutput(ctx: ToolContext, snap: Awaited<ReturnType<ToolContext["app"]["browser"]["snapshot"]>>) {
  ctx.app.threads.addRelated(ctx.thread.id, { kind: "page", title: snap.title || snap.url, url: snap.url });
  return { text: formatSnapshot(snap), source: snap.url, details: { url: snap.url } };
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
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.open(ctx.thread.id, args.url, Boolean(args.new_tab)));
    },
  }),
  defineTool({
    name: "browser_snapshot",
    label: "Look at page",
    description: "Re-read the current page and its element refs. Refs from older snapshots may stop working after the page changes.",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.snapshot(ctx.thread.id));
    },
  }),
  defineTool({
    name: "browser_read",
    label: "Read page",
    description: "Return the visible text of the current page, for reading articles, prices or long result lists.",
    parameters: Type.Object({}),
    async run(_args, ctx) {
      const r = await ctx.app.browser.read(ctx.thread.id);
      return { text: `URL: ${r.url}\nTitle: ${r.title}\n\n${r.text}`, source: r.url, details: { url: r.url } };
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
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.select(ctx.thread.id, args.ref, args.values));
    },
  }),
  defineTool({
    name: "browser_check",
    label: "Tick box",
    description: "Check or uncheck a checkbox, radio button or switch by ref.",
    parameters: Type.Object({ ref: Ref, checked: Type.Boolean() }),
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.check(ctx.thread.id, args.ref, args.checked));
    },
  }),
  defineTool({
    name: "browser_hover",
    label: "Hover",
    description: "Move the mouse over an element by ref, to open hover menus or tooltips.",
    parameters: Type.Object({ ref: Ref }),
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
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.scroll(ctx.thread.id, args.direction ?? "down", args.ref));
    },
  }),
  defineTool({
    name: "browser_wait",
    label: "Wait",
    description: "Wait until some text appears on the page, or for a number of seconds (max 20), when results are still loading.",
    parameters: Type.Object({ text: Type.Optional(Type.String()), seconds: Type.Optional(Type.Number({ minimum: 0.5, maximum: 20 })) }),
    async run(args, ctx) {
      return snapshotOutput(ctx, await ctx.app.browser.wait(ctx.thread.id, args));
    },
  }),
  defineTool({
    name: "browser_back",
    label: "Go back",
    description: "Go back (or forward) in the current tab's history.",
    parameters: Type.Object({ forward: Type.Optional(Type.Boolean()) }),
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
    name: "browser_ask_owner",
    label: "Hand the browser to you",
    description: [
      "Hand this thread's browser to the owner for something only they should do: signing in (password, SSO, two-factor, passkey), a captcha, or a choice that is theirs to make.",
      "Open the page first. The owner sees it in Vireo, does the step by hand and hands the browser back; this call waits until then (up to 20 minutes) and returns the page as it is now.",
      "Never ask the owner for their password or codes in chat instead.",
    ].join(" "),
    parameters: Type.Object({
      request: Type.String({ description: "What the owner should do, short and in their language, e.g. 'Sign in to Tailscale and press Connect'" }),
    }),
    async run(args, ctx) {
      const request = args.request.trim().slice(0, 120);
      ctx.app.threads.setStatus(ctx.thread.id, `Waiting for you in the browser: ${request}`);
      void ctx.app.push.notify({ title: "Vireo needs you in the browser", body: request, url: `/#thread/${ctx.thread.id}`, tag: `browser-${ctx.thread.id}` });
      const done = await ctx.app.browser.askOwner(ctx.thread.id, request, 20 * 60_000, ctx.signal);
      const snap = await ctx.app.browser.snapshot(ctx.thread.id);
      const out = snapshotOutput(ctx, snap);
      return {
        ...out,
        text: done
          ? `The owner handed the browser back. Check the page below to see whether "${request}" is done.\n\n${out.text}`
          : `The owner did not hand the browser back within 20 minutes, so you have it again. Say in the thread what is still needed and stop; do not retry.\n\n${out.text}`,
      };
    },
  }),
  defineTool({
    name: "plugin_save_from_page",
    label: "Save a key into a plugin",
    description: [
      "Save a key or token that is on the current page (one you just created in a service's console) into a plugin's settings.",
      "Keys a plugin recognises are hidden from you on pages; this reads the real value from the page itself, checks it, stores it encrypted and restarts the plugin. You never see it and must never repeat it.",
      "Pass ref to read one element (the field or box showing the key); without ref the whole page is searched for the field's format.",
    ].join(" "),
    parameters: Type.Object({
      plugin: Type.String({ description: "Plugin id, e.g. 'tailscale'" }),
      field: Type.String({ description: "Setting key from plugin_setup, e.g. 'api_key'" }),
      ref: Type.Optional(Ref),
    }),
    async run(args, ctx) {
      await ctx.app.browser.waitForOwner(ctx.thread.id, ctx.signal);
      const def = ctx.app.plugins.definition(args.plugin);
      const field = def.fields.find((f) => f.key === args.field);
      if (!field) throw new Error(`${def.name} has no setting "${args.field}". Settings: ${def.fields.map((f) => f.key).join(", ")}.`);
      const raw = await ctx.app.browser.rawText(ctx.thread.id, args.ref);
      let value: string | undefined;
      if (field.pattern) {
        const found = [...new Set(raw.match(new RegExp(field.pattern, "g")) ?? [])];
        if (found.length > 1) throw new Error(`The page shows ${found.length} different values that look like a ${field.label}; pass the ref of the one you created.`);
        value = found[0];
      } else if (args.ref) {
        value = raw.split("\n").map((l) => l.trim()).find(Boolean);
      } else {
        throw new Error(`Pass the ref of the element that shows the ${field.label}.`);
      }
      if (!value) throw new Error(`No ${field.label} found ${args.ref ? "in that element" : "on the page"}. Make sure it is shown (some consoles show a key only once, right after it is created).`);
      await ctx.app.plugins.saveValue(def.id, field.key, value);
      const st = await ctx.app.plugins.statusOf(def.id);
      return {
        text: `Saved the ${field.label} to ${def.name}${field.type === "secret" ? " (encrypted; it stays hidden)" : ""}. ${def.name} is now ${st?.state ?? "added"}${st?.message ? `: ${st.message}` : "."}`,
        details: { plugin: def.id, field: field.key, state: st?.state },
      };
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
