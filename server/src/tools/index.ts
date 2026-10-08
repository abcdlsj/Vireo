import { browserTools } from "./browser.js";
import { calendarTools } from "./calendar.js";
import { emailTools } from "./email.js";
import { fileTools } from "./files.js";
import { memoryTools } from "./memory.js";
import { researchTools } from "./research.js";
import { threadTools } from "./threads.js";
import type { ToolDef } from "./types.js";

/** Every tool Vireo knows. New services plug in by adding a module here. */
export function buildTools(): Map<string, ToolDef> {
  const all = [...memoryTools, ...threadTools, ...researchTools, ...calendarTools, ...emailTools, ...browserTools, ...fileTools] as ToolDef[];
  return new Map(all.map((t) => [t.name, t]));
}
