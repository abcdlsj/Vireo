import type { Message } from "@vireo/protocol";
import type { StoredMessage } from "../threads.js";
import { truncate } from "../util.js";

/** A stored message as the app shows it. */
export function viewMessage(m: StoredMessage): Message {
  const b = m.body as unknown as Record<string, unknown>;
  if (m.role === "notice") {
    return { id: m.id, role: "notice", kind: String(b.kind), text: String(b.text), data: (b.data as Record<string, unknown>) ?? null, createdAt: m.createdAt };
  }
  if (m.role === "user") {
    const content = b.content as string | { type: string; text?: string; mimeType?: string; data?: string }[];
    const text = typeof content === "string" ? content : content.filter((x) => x.type === "text").map((x) => x.text).join("");
    const images = typeof content === "string" ? [] : content.filter((x) => x.type === "image").map((x) => `data:${x.mimeType};base64,${x.data}`);
    return { id: m.id, role: "user", text, images, fromVireo: m.agent === "vireo", createdAt: m.createdAt };
  }
  if (m.role === "assistant") {
    const content = b.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[];
    return {
      id: m.id,
      role: "assistant",
      agent: m.agent,
      text: content.filter((x) => x.type === "text").map((x) => x.text).join(""),
      thinking: content.filter((x) => x.type === "thinking").map((x) => x.thinking).join("") || undefined,
      toolCalls: content.filter((x) => x.type === "toolCall").map((x) => ({ id: x.id!, name: x.name!, args: x.arguments ?? {} })),
      createdAt: m.createdAt,
    };
  }
  const content = (b.content as { type: string; text?: string }[]) ?? [];
  return {
    id: m.id,
    role: "tool",
    toolCallId: String(b.toolCallId),
    toolName: String(b.toolName),
    isError: Boolean(b.isError),
    text: truncate(content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), 3000),
    awaitingConfirmation: (b.details as { awaitingConfirmation?: string } | undefined)?.awaitingConfirmation,
    createdAt: m.createdAt,
  };
}
