import { describe, expect, it } from "vitest";
import { normalizeCode, Pairing } from "../../apps/host/src/pairing.js";
import { tempDb } from "./helpers.js";

describe("host pairing codes", () => {
  it("are single use and accept any spacing or case", () => {
    const { db } = tempDb();
    const pairing = new Pairing(db);
    const { code } = pairing.create();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(pairing.redeem(" " + code.toLowerCase().replace("-", " "))).toBe(true);
    expect(pairing.redeem(code)).toBe(false);
  });

  it("expire", () => {
    const { db } = tempDb();
    const pairing = new Pairing(db);
    const { code } = pairing.create(-1);
    expect(pairing.redeem(code)).toBe(false);
  });

  it("reject wrong codes without consuming valid ones", () => {
    const { db } = tempDb();
    const pairing = new Pairing(db);
    const a = pairing.create().code;
    const b = pairing.create().code;
    expect(pairing.redeem("AAAA-AAAA")).toBe(false);
    expect(pairing.redeem(b)).toBe(true);
    expect(pairing.redeem(a)).toBe(true);
    expect(normalizeCode("k7qm-2xpa")).toBe("K7QM2XPA");
  });
});
