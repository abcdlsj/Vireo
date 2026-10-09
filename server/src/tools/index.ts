import { browserTools } from "./browser.js";
import { calendarTools } from "./calendar.js";
import { cardTools } from "./cards.js";
import { emailTools } from "./email.js";
import { fileTools } from "./files.js";
import { memoryTools } from "./memory.js";
import { researchTools } from "./research.js";
import { threadTools } from "./threads.js";
import type { ToolDef } from "./types.js";

/** Every built-in tool, plus tools from installed plugins. */
export function buildTools(extra: ToolDef[] = []): Map<string, ToolDef> {
  const all = [...extra, ...memoryTools, ...threadTools, ...cardTools, ...researchTools, ...calendarTools, ...emailTools, ...browserTools, ...fileTools] as ToolDef[];
  return new Map(all.map((t) => [t.name, t]));
}
