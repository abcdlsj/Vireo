/**
 * Vireo's own message format, as stored per thread. It is independent of any
 * model SDK: the runner converts it to the OpenAI Agents SDK's input items
 * before a run, and converts run items back as they are produced.
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Base64 data without the data: prefix. */
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  model?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  /** Set when the content came from outside the owner; the model reads it framed as untrusted (S2). */
  source?: string;
  isError: boolean;
  details?: Record<string, unknown>;
  timestamp: number;
}

/** A notice is a Vireo-authored event in a thread (confirmations, reminders, links). */
export interface NoticeBody {
  role: "notice";
  kind: string;
  text: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** What a model sees: notices are shown to it as short user-side lines. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AgentMessage = Message | NoticeBody;

export function contentText(m: AgentMessage): string {
  if (m.role === "notice") return m.text;
  if (typeof m.content === "string") return m.content;
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
