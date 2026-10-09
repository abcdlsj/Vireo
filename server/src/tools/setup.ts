import { Type } from "typebox";
import { defineTool } from "./types.js";

/**
 * When the owner asks for something a plugin would make possible, the
 * assistant points them at the one place to set it up and picks the matter
 * up again on its own once the plugin is ready.
 */
export const setupTools = [
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
        ].join("\n"),
        details: { plugin: cap.id, state: cap.state },
      };
    },
  }),
];
