import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeResponse, seenContexts } from "./fake-model.js";
import type { AssistantMessage, Message, TextContent, ToolCall } from "./messages.js";
import { now, safeJson } from "./util.js";

/**
 * Serves the scripted model over the OpenAI Chat Completions protocol on a
 * loopback port. In demo and test mode Vireo talks to it exactly as it would
 * to OpenAI, LiteLLM or any compatible endpoint, so the whole path (Agents
 * SDK, OpenAI client, streaming, tool calls, handoffs) is exercised.
 */

export const FAKE_MODELS = ["fake-main", "fake-fast"];

interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
}

function partsText(content: ChatMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** Chat Completions messages back into Vireo's message shape for the scripted brain. */
export function fromChat(messages: ChatMessage[]): { systemPrompt: string; messages: Message[] } {
  const system: string[] = [];
  const out: Message[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") system.push(partsText(m.content));
    else if (m.role === "user") out.push({ role: "user", content: partsText(m.content), timestamp: now() });
    else if (m.role === "assistant") {
      const blocks: (TextContent | ToolCall)[] = [];
      const t = partsText(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function.name);
        blocks.push({ type: "toolCall", id: c.id, name: c.function.name, arguments: safeJson(c.function.arguments, {}) });
      }
      out.push({ role: "assistant", content: blocks, timestamp: now() });
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      out.push({ role: "toolResult", toolCallId: id, toolName: names.get(id) ?? "", content: [{ type: "text", text: partsText(m.content) }], isError: false, timestamp: now() });
    }
  }
  return { systemPrompt: system.join("\n\n"), messages: out };
}

function respond(req: ChatRequest): AssistantMessage {
  const { systemPrompt, messages } = fromChat(req.messages);
  return fakeResponse({ systemPrompt, messages, tools: (req.tools ?? []).map((t) => ({ name: t.function.name })) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLlmServer(listenPort = 0): Promise<{ url: string; server: Server }> {
  const tokensPerSecond = Number(process.env.VIREO_FAKE_TOKENS_PER_SECOND ?? 400);
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: FAKE_MODELS.map((id) => ({ id, object: "model", owned_by: "vireo" })) }));
      return;
    }
    if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The scripted model only speaks Chat Completions." } }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as ChatRequest;
    const message = respond(body);
    const text = message.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
    const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil((text.length + JSON.stringify(calls).length) / 4) };
    const toolCalls = calls.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
    const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: body.model };
    const finish = calls.length ? "tool_calls" : "stop";

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finish }],
          usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
      res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`);
    send({ delta: { role: "assistant", content: "" } });
    const pieces = text.match(/\S+\s*|\s+/g) ?? [];
    const delay = tokensPerSecond > 0 ? 1000 / tokensPerSecond : 0;
    for (const p of pieces) {
      send({ delta: { content: p } });
      if (delay) await sleep(delay);
    }
    if (toolCalls.length) send({ delta: { tool_calls: toolCalls } });
    send({ delta: {}, finish_reason: finish });
    send(null, { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
  server.unref();
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, server };
}

export { seenContexts };
