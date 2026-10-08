// A tiny MCP server over stdio for tests: one read-only tool and one that changes things.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" }, { instructions: "Notes for tests." });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text} (token ${process.env.FIXTURE_TOKEN ?? "none"})` }] }),
);
server.registerTool("create_note", { description: "Create a note", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `created ${text}` }] }));
await server.connect(new StdioServerTransport());
