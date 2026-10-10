import { describe, expect, it } from "vitest";
import { Bus } from "../../apps/host/src/bus.js";
import { MemoryStore, normaliseKey } from "../../apps/host/src/memory.js";
import { tempDb } from "./helpers.js";

describe("memory graph", () => {
  it("supersedes a fact with the same entity and key, keeping history", () => {
    const mem = new MemoryStore(tempDb().db, new Bus());
    const first = mem.addFact({ key: "home_address", statement: "Owner lives at 1 Old Street" }).fact;
    const { fact: second, superseded } = mem.addFact({ key: "Home address", statement: "Owner lives at 99 New Road" });
    expect(superseded.map((f) => f.id)).toEqual([first.id]);
    expect(mem.list({ query: "lives" }).map((f) => f.statement)).toEqual(["Owner lives at 99 New Road"]);
    const old = mem.fact(first.id)!;
    expect(old.current).toBe(false);
    expect(old.supersededBy).toBe(second.id);
    expect(mem.history(second.id).map((f) => f.statement)).toContain("Owner lives at 1 Old Street");
  });

  it("does not duplicate a repeated statement", () => {
    const mem = new MemoryStore(tempDb().db, new Bus());
    mem.addFact({ key: "seat", statement: "Owner prefers aisle seats" });
    const again = mem.addFact({ key: "seat", statement: "owner prefers aisle seats " });
    expect(again.unchanged).toBe(true);
    expect(mem.list({ includeHistory: true })).toHaveLength(1);
  });

  it("answers what was true at a point in time", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const mem = new MemoryStore(tempDb().db, new Bus());
    const before = Date.now() - 1;
    await tick();
    const old = mem.addFact({ key: "employer", statement: "Owner works at Acme" }).fact;
    const between = old.validFrom;
    await tick(); // the replacement must be strictly later than "between"
    mem.addFact({ key: "employer", statement: "Owner works at Globex" });
    expect(mem.asOf(before, "works")).toHaveLength(0);
    expect(mem.asOf(between, "works").map((f) => f.statement)).toEqual(["Owner works at Acme"]);
    expect(mem.asOf(Date.now() + 1, "works").map((f) => f.statement)).toEqual(["Owner works at Globex"]);
  });

  it("drops expired facts from the current view", () => {
    const mem = new MemoryStore(tempDb().db, new Bus());
    mem.addFact({ key: "trip", statement: "Owner is in Kyoto this week", validUntil: Date.now() - 1000 });
    mem.addFact({ key: "diet", statement: "Owner is vegetarian" });
    expect(mem.list().map((f) => f.statement)).toEqual(["Owner is vegetarian"]);
    expect(mem.list({ includeHistory: true })).toHaveLength(2);
  });

  it("lets the owner correct and delete facts", () => {
    const mem = new MemoryStore(tempDb().db, new Bus());
    const f = mem.addFact({ entity: "Anna", key: "relationship_to_owner", statement: "Anna is the owner's sister" }).fact;
    const fixed = mem.correct(f.id, "Anna is the owner's younger sister");
    expect(fixed.entityName).toBe("Anna");
    expect(mem.list({ query: "Anna" }).map((x) => x.statement)).toEqual(["Anna is the owner's younger sister"]);
    expect(mem.delete(fixed.id)).toBe(true);
    expect(mem.list({ query: "younger" })).toHaveLength(0);
  });

  it("resolves owner aliases to the owner entity and normalises keys", () => {
    const mem = new MemoryStore(tempDb().db, new Bus());
    expect(mem.resolveEntity("me").id).toBe(mem.resolveEntity("我").id);
    expect(mem.resolveEntity("Anna").id).toBe(mem.resolveEntity("anna").id);
    expect(normaliseKey(" Home Address! ")).toBe("home_address");
    expect(normaliseKey("饮食 偏好")).toBe("饮食_偏好");
  });
});
