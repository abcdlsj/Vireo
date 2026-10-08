import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normaliseDomain, Vault } from "../../server/src/vault.js";
import { tempDb } from "./helpers.js";

describe("credential vault", () => {
  it("stores passwords encrypted and finds them by host", () => {
    const { db, dir } = tempDb();
    const vault = new Vault(db, dir);
    vault.add("https://www.example.com/login", "lisa", "hunter2-secret");
    expect(vault.list()).toEqual([expect.objectContaining({ domain: "example.com", username: "lisa" })]);
    expect(vault.forHost("shop.example.com")?.password).toBe("hunter2-secret");
    expect(vault.forHost("example.org")).toBeUndefined();
    db.close();
    expect(readFileSync(join(dir, "vireo.db")).includes(Buffer.from("hunter2-secret"))).toBe(false);
  });

  it("redacts every stored secret from text", () => {
    const { db, dir } = tempDb();
    const vault = new Vault(db, dir);
    vault.add("example.com", "lisa", "hunter2-secret");
    expect(vault.redact("typed hunter2-secret into the form")).toBe("typed [secret] into the form");
  });

  it("detects tampering", () => {
    const { db, dir } = tempDb();
    const vault = new Vault(db, dir);
    const blob = Buffer.from(vault.encrypt("value"), "base64");
    blob[blob.length - 1] ^= 1;
    expect(() => vault.decrypt(blob.toString("base64"))).toThrow();
  });

  it("normalises domains", () => {
    expect(normaliseDomain("https://WWW.Example.com:8443/path")).toBe("example.com");
    expect(normaliseDomain("  example.com ")).toBe("example.com");
  });
});
