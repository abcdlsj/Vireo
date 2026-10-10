/** Live updates a node streams to every open app over server-sent events. */
export type NodeEvent =
  | { type: "thread.updated"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "message.created"; threadId: string; messageId: number }
  | { type: "message.delta"; threadId: string; streamId: string; delta: string; kind: "text" | "thinking" }
  | { type: "message.stream_start"; threadId: string; streamId: string; agent: string }
  | { type: "message.stream_end"; threadId: string; streamId: string }
  | { type: "step"; threadId: string; step: { tool: string; label: string; status: string; toolCallId?: string } }
  | { type: "action.updated"; threadId: string; actionId: string }
  | { type: "card.updated"; threadId: string; cardId: string }
  | { type: "memory.updated" }
  | { type: "procedure.updated" }
  | { type: "plugins.updated" };
