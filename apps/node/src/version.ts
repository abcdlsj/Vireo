import { readFileSync } from "node:fs";

/** This node's version, from its package.json (one level above both src/ and dist/). */
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
