import { Type } from "typebox";
import { defineTool } from "./types.js";

/**
 * When the owner asks for something a plugin would make possible, the
 * assistant points them at the one place to set it up and picks the matter
 * up again on its own once the plugin is ready.
 */
export const setupTools = [
  defineTool({
    name: "plugin_setup",
    label: "Set up a plugin",
    description: [
      "Start or check setting up a plugin in Vireo's browser, once the owner asked you to do it for them.",
      "Adds the plugin if needed and returns its status (with any sign-in link), which settings are filled, and the steps to follow with the browser tools, browser_ask_owner and plugin_save_from_page.",
      "Call it again after each step to see where things stand.",
    ].join(" "),
    parameters: Type.Object({
      plugin: Type.String({ description: "Plugin id, e.g. 'tailscale'" }),
    }),
    async run(args, ctx) {
      const plugins = ctx.app.plugins;
      const def = plugins.definition(args.plugin);
      if (!def.browserSetup?.length) {
        return { text: `${def.name} cannot be set up in the browser. Send the owner to its settings instead: [${def.name}](#settings/plugins/${def.id})` };
      }
      if (!plugins.installed(def.id)) {
        ctx.app.threads.setStatus(ctx.thread.id, `Adding ${def.name}…`);
        await plugins.install(def.id);
      }
      const st = await plugins.statusOf(def.id);
      const cfg = plugins.config(def.id);
      const fields = def.fields.map((f) => {
        const v = cfg[f.key];
        const shown = f.type === "secret" ? (v ? "set" : "not set") : v === "" || v == null ? "empty" : JSON.stringify(v);
        return `- ${f.key} (${f.label}): ${shown}`;
      });
      return {
        text: [
          `${def.name}: ${st?.state ?? "unknown"}${st?.message ? ` — ${st.message}` : ""}`,
          st?.link ? `Sign-in link: ${st.link.href}` : "",
          ...(st?.details ?? []).map((d) => `${d.label}: ${d.value}`),
          "",
          "Settings:",
          ...fields,
          "",
          st?.state === "ready" ? "It is ready. Do only the steps that add something the owner asked for (for example an API token), then tell them it is done." : "Steps:",
          ...def.browserSetup.map((step, i) => `${i + 1}. ${step}`),
          "",
          "Rules: the owner signs in themselves; open the page and call browser_ask_owner, never ask for passwords or codes in chat and never type them. Keys you create are hidden from you on the page; save them with plugin_save_from_page and never repeat or summarise them. Settings you change are the owner's to see in Settings → Plugins.",
        ]
          .filter((l, i, all) => l !== "" || all[i - 1] !== "")
          .join("\n"),
        details: { plugin: def.id, state: st?.state },
      };
    },
  }),
  defineTool({
    name: "suggest_setup",
    label: "Suggest setup",
    description: [
      "Call this when the owner asks for something that needs a capability listed under 'Capabilities that are not ready', instead of attempting it without the capability or refusing.",
      "It returns a link to that plugin's settings for your reply, and this thread picks the request up again by itself once the plugin is ready.",
      "Only for what the owner asked for now; never to advertise plugins.",
    ].join(" "),
    parameters: Type.Object({
      plugin: Type.String({ description: "The plugin id from the capabilities list, e.g. 'google'" }),
    }),
    async run(args, ctx) {
      const cap = ctx.app.plugins.capabilities().find((c) => c.id === args.plugin);
      if (!cap) {
        const ids = ctx.app.plugins.capabilities().map((c) => c.id);
        throw new Error(`Unknown plugin "${args.plugin}". Use one of: ${ids.join(", ")}.`);
      }
      if (cap.state === "ready") return { text: `${cap.name} is already set up and ready. Go ahead with the request.` };
      ctx.app.plugins.waitForSetup(ctx.thread.id, cap.id);
      const link = `[${cap.name}](#settings/plugins/${cap.id})`;
      return {
        text: [
          cap.state === "not_added"
            ? `${cap.name} is not added yet. The owner adds it in Settings → Plugins.`
            : `${cap.name} is added but not ready: ${cap.message ?? "its settings are incomplete"}.`,
          `In one or two sentences, in the owner's language, say what this unlocks for their request and what they need to do, and include this link exactly: ${link}`,
          "Do not walk through the setup steps; the settings page explains them. This thread continues by itself once it is ready, so say that too and stop here.",
          cap.browserSetup
            ? "Also offer, in one sentence, to do the setup for them: Vireo opens the sign-in page in its own browser, they sign in there themselves, and Vireo creates the keys and saves them into the plugin. If they accept, hand off to browser, which calls plugin_setup."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        details: { plugin: cap.id, state: cap.state },
      };
    },
  }),
];
