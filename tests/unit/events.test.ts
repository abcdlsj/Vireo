import { describe, expect, it } from "vitest";
import { mergeDeltas } from "../../apps/node/src/http/events.js";

describe("live events", () => {
  it("joins runs of deltas of one stream and kind, keeping other events in order", () => {
    const merged = mergeDeltas([
      { type: "message.delta", threadId: "t", streamId: "s", delta: "Hel", kind: "text" },
      { type: "message.delta", threadId: "t", streamId: "s", delta: "lo", kind: "text" },
      { type: "message.delta", threadId: "t", streamId: "s", delta: "hmm", kind: "thinking" },
      { type: "thread.updated", threadId: "t" },
      { type: "message.delta", threadId: "t", streamId: "s", delta: " there", kind: "text" },
      { type: "message.delta", threadId: "u", streamId: "s2", delta: "x", kind: "text" },
    ]);
    expect(merged).toEqual([
      { type: "message.delta", threadId: "t", streamId: "s", delta: "Hello", kind: "text" },
      { type: "message.delta", threadId: "t", streamId: "s", delta: "hmm", kind: "thinking" },
      { type: "thread.updated", threadId: "t" },
      { type: "message.delta", threadId: "t", streamId: "s", delta: " there", kind: "text" },
      { type: "message.delta", threadId: "u", streamId: "s2", delta: "x", kind: "text" },
    ]);
  });
});
