#!/usr/bin/env node
// Acceptance run: executes the unit and end-to-end suites, then maps every
// PRD acceptance criterion to the test that covers it and writes
// acceptance-report.md. Exits non-zero if any criterion fails.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const CRITERIA = [
  ["Milestone 1 — Threads that think", [
    ["M1.1", "The owner can install the PWA on iPhone and Mac and sign in."],
    ["M1.2", "Creating a thread, getting a named thread and a streamed answer works end to end."],
    ["M1.3", "Two threads running at once do not mix context."],
    ["M1.4", "A research question returns a sourced summary."],
    ["M1.5", "Model access is configurable."],
  ]],
  ["Milestone 2 — Vireo remembers", [
    ["M2.1", "A preference stated in one thread is used, unprompted, in a new thread."],
    ["M2.2", "Changing a fact makes Vireo use the new one and stop using the old one."],
    ["M2.3", "\"What do you remember about X\" returns facts with sources; the owner can correct and delete them."],
    ["M2.4", "Temporary threads leave nothing in memory."],
  ]],
  ["Milestone 3 — Calendar and email", [
    ["M3.1", "Scheduling a meeting finds a free slot and creates the event after confirmation."],
    ["M3.2", "An email needing a reply produces its own thread with a summary and a draft; sending requires confirmation."],
    ["M3.3", "A confirmation tapped on the phone resumes the paused work."],
    ["M3.4", "Nothing outward-facing happens without confirmation."],
  ]],
  ["Milestone 4 — Proactive and hands-on", [
    ["M4.2", "A multi-step website task completes, pausing for confirmation before submitting."],
    ["M4.3", "Credentials never appear in prompts or logs."],
    ["M4.4", "Every action in a thread can be inspected in its audit trail."],
  ]],
  ["Milestone 5 — Plugins", [
    ["M5.1", "A community plugin is added from Settings and configured there; secrets never return to the browser."],
    ["M5.2", "Tailscale lists, reaches and runs commands on the owner's tailnet machines, with confirmation."],
    ["M5.3", "Google (Calendar, Gmail, Drive) is a plugin."],
  ]],
  ["Milestone 6 — Hosts", [
    ["M6.1", "The app pairs with a remote host by a one-time code and switches between hosts."],
    ["M6.2", "The host is headless; the UI is a separate app."],
  ]],
  ["Capabilities", [
    ["C1", "Overview answers quick things and opens threads for multi-step matters."],
    ["C7", "Calendar conflicts and invitations open their own threads."],
    ["C8", "Reminders and follow-ups fire in their thread and notify the owner."],
    ["C9", "Files can be attached and are returned."],
    ["Lifecycle", "Threads can be marked done (summarised) and reopened."],
  ]],
];

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  return spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
}

rmSync(".vireo-test/results.json", { force: true });
rmSync(".vireo-test/unit-results.json", { force: true });
const unitStatus = run("npx", ["vitest", "run"]);
const e2eStatus = run("npx", ["playwright", "test"]);

// Collect end-to-end results by the [ID] tag in each test title.
const e2e = new Map();
if (existsSync(".vireo-test/results.json")) {
  const walk = (suite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      const id = spec.title.match(/^\[([^\]]+)\]/)?.[1];
      if (!id) continue;
      const results = spec.tests.flatMap((t) => t.results);
      const ok = spec.ok && results.length > 0 && results.every((r) => r.status === "passed");
      const ms = results.reduce((n, r) => n + (r.duration ?? 0), 0);
      e2e.set(id, { ok, title: spec.title.replace(/^\[[^\]]+\]\s*/, ""), file: spec.file, ms });
    }
  };
  walk(JSON.parse(readFileSync(".vireo-test/results.json", "utf8")));
}

let unit = { total: 0, passed: 0, failed: [] };
if (existsSync(".vireo-test/unit-results.json")) {
  const r = JSON.parse(readFileSync(".vireo-test/unit-results.json", "utf8"));
  unit.total = r.numTotalTests;
  unit.passed = r.numPassedTests;
  unit.failed = r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status !== "passed").map((a) => a.fullName));
}

const lines = [
  "# Vireo acceptance report",
  "",
  `Generated ${new Date().toISOString()} on Node ${process.version}.`,
  "",
  "Every PRD acceptance criterion is checked by an end-to-end test that drives the real server and the PWA in Chromium, with the scripted model, an in-memory mailbox and a local fixture website. See docs/ACCEPTANCE.md for the manual check with a real model.",
  "",
];
let failures = 0;
for (const [section, items] of CRITERIA) {
  lines.push(`## ${section}`, "", "| | Criterion | Test |", "|---|---|---|");
  for (const [id, text] of items) {
    const r = e2e.get(id);
    if (!r?.ok) failures++;
    const mark = r ? (r.ok ? "PASS" : "FAIL") : "MISSING";
    lines.push(`| ${mark} | **${id}** ${text} | ${r ? `${r.file} (${(r.ms / 1000).toFixed(1)}s)` : "no test found"} |`);
  }
  lines.push("");
}
lines.push("## Unit and integration tests", "", `${unit.passed} of ${unit.total} passed.`);
for (const f of unit.failed) lines.push(`- FAIL ${f}`);
lines.push("");
const allOk = failures === 0 && unitStatus === 0 && e2eStatus === 0;
lines.push(`**Result: ${allOk ? "ACCEPTED" : "NOT ACCEPTED"}**`, "");

writeFileSync("acceptance-report.md", lines.join("\n"));
console.log(`\n${lines.join("\n")}\nWrote acceptance-report.md`);
process.exit(allOk ? 0 : 1);
