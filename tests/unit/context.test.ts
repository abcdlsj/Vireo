import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { extractJson } from "../../server/src/models.js";
import { convertToLlm, fitContext } from "../../server/src/runner.js";

const model = { contextWindow: 10_000 } as Model<Api>;

function turn(i: number, size: number): AgentMessage[] {
  return [
    { role: "user", content: `question ${i}`, timestamp: i },
    { role: "toolResult", toolCallId: `c${i}`, toolName: "fetch_page", content: [{ type: "text", text: "x".repeat(size) }], isError: false, timestamp: i },
  ] as AgentMessage[];
}

describe("context handling", () => {
  it("leaves small conversations untouched", () => {
    const msgs = turn(1, 100);
    expect(fitContext(msgs, model)).toBe(msgs);
  });

  it("trims old tool output first, then the oldest turns, and always starts on a user turn", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => turn(i, 4000)).flat();
    const out = fitContext(msgs, model);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(msgs).length / 3);
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)).toEqual(msgs.at(-1)); // the latest tool output is kept intact
  });

  it("shows Vireo notices to the model as user turns", () => {
    const out = convertToLlm([{ role: "notice", text: "The owner confirmed", timestamp: 1 } as unknown as AgentMessage]);
    expect(out).toEqual([expect.objectContaining({ role: "user", content: "[Vireo notice] The owner confirmed" })]);
  });

  it("extracts JSON from model output", () => {
    expect(extractJson<{ a: number }>('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson<number[]>("Here you go [1, 2, 3] done")).toEqual([1, 2, 3]);
    expect(extractJson("no json here")).toBeUndefined();
  });
});
