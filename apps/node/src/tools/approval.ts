import { Type } from "typebox";
import { defineTool } from "./types.js";

export const APPROVAL_TOOL = "agent_approval";

/**
 * An approval another agent or node asked the owner for over MCP. It is never
 * offered to Vireo's own agents: only the owner's confirmation card runs it,
 * and their decision settles the matter without resuming the thread.
 */
export const approvalTools = [
  defineTool({
    name: APPROVAL_TOOL,
    label: "Approve an agent's request",
    description: "An approval an agent asked the owner for over MCP. Only the owner's confirmation card runs it.",
    parameters: Type.Object({ from: Type.String(), description: Type.Optional(Type.String()) }),
    confirm: () => true,
    settles: true,
    async run(args) {
      return { text: `Approved; ${args.from} is told when it checks.`, display: { note: `${args.from} can go ahead.` } };
    },
  }),
];
