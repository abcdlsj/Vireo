import { describe, expect, it } from "vitest";
import { diffCard } from "../../apps/host/src/cards/diff.js";

describe("card diff", () => {
  it("names a changed fact by the item it belongs to", () => {
    const before = {
      blocks: [
        {
          type: "rows",
          items: [
            { title: "Celestine", value: "¥2,180" },
            { title: "Mitsui", value: "¥1,640" },
          ],
        },
      ],
    };
    const after = {
      blocks: [
        {
          type: "rows",
          items: [
            { title: "Celestine", value: "¥1,990", mark: "best" },
            { title: "Mitsui", value: "¥1,640" },
          ],
        },
      ],
    };
    expect(diffCard(before, after)).toEqual([{ label: "Celestine", from: "¥2,180", to: "¥1,990" }]);
  });

  it("says nothing when the card changed throughout or only in quiet fields", () => {
    expect(diffCard({ a: "1", b: "1", c: "1", d: "1" }, { a: "2", b: "2", c: "2", d: "2" })).toEqual([]);
    expect(diffCard({ trend: [1, 2], checked_at: "x" }, { trend: [1, 2, 3], checked_at: "y" })).toEqual([]);
    expect(diffCard({ text: "a".repeat(50) }, { text: "b".repeat(50) })).toEqual([]);
  });

  it("labels nested fields by their path", () => {
    expect(diffCard({ return: { price: "¥2,202" } }, { return: { price: "¥2,137" } })).toEqual([{ label: "Return price", from: "¥2,202", to: "¥2,137" }]);
  });
});
