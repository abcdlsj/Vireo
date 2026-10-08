import type { AssistantMessage, Message, TextContent, ToolCall } from "./messages.js";
import { newId, now } from "./util.js";

/**
 * A deterministic, rule-based stand-in for a real model, used by the
 * end-to-end tests and demo mode (VIREO_FAKE_MODEL=1). It is served over the
 * OpenAI Chat Completions protocol (see fake-llm-server.ts) and only reads
 * what a real model would see — the system prompt, this thread's messages and
 * tool results — so the tests exercise Vireo's real plumbing: the Agents SDK,
 * routing, handoffs, per-thread context, memory injection, tools and
 * confirmations.
 */

export interface FakeContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: { name: string }[];
}

type Block = TextContent | ToolCall;

function text(m: Message): string {
  if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (m.role === "assistant") return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function reply(content: string | Block | Block[]): AssistantMessage {
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : Array.isArray(content) ? content : [content];
  return { role: "assistant", content: blocks, model: "fake", timestamp: now() };
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return reply({ type: "toolCall", id: newId("call"), name, arguments: args });
}

const isCjk = (s: string) => /[\u3400-\u9fff]/.test(s);

/** Everything the scripted model was shown (test mode only), so tests can assert what never reaches a model. */
export const seenContexts: string[] = [];

export function fakeResponse(context: FakeContext): AssistantMessage {
  if (process.env.VIREO_TEST_MODE) {
    seenContexts.push(JSON.stringify({ system: context.systemPrompt, messages: context.messages }));
    if (seenContexts.length > 5000) seenContexts.splice(0, 1000);
  }
  const system = context.systemPrompt ?? "";
  const task = system.match(/^Task: (\w+)/)?.[1];
  if (task) return reply(routine(task, system, text(context.messages.at(-1)!)));
  return agentTurn(context);
}

// ---------------------------------------------------------------- routine work

function routine(task: string, system: string, prompt: string): string {
  switch (task) {
    case "thread_title": {
      const cleaned = prompt
        .split("\n")[0]!
        .replace(/^(please|can you|could you|hey vireo,?|vireo,?|帮我|请)\s*/i, "")
        .replace(/[.?!。？！]+$/, "");
      if (isCjk(cleaned)) return cleaned.slice(0, 16);
      const words = cleaned.split(/\s+/).slice(0, 7).join(" ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
    case "thread_summary": {
      const first = prompt.match(/Owner: (.+)/)?.[1] ?? "the matter";
      return `Handled: ${first.slice(0, 80)}`;
    }
    case "memory_extract":
      return JSON.stringify({ facts: extractFacts(prompt) });
    case "procedure_proposal":
      return JSON.stringify({
        procedure: /Booking confirmed/i.test(prompt)
          ? { name: "Book a restaurant table", description: "When the owner asks to book a table online", steps: "1. Sign in with stored credentials.\n2. Fill name, guests and date.\n3. Ask the owner to confirm before submitting." }
          : null,
      });
    case "email_triage":
      return JSON.stringify({ needs_reply: !/newsletter|unsubscribe|receipt|no-?reply|digest/i.test(prompt), reason: "scripted" });
    case "morning_brief":
      return `Good morning! Here is your brief.\n\n${prompt}`;
    default:
      return "OK";
  }
}

interface Extracted {
  entity: string;
  entity_kind: string;
  key: string;
  statement: string;
  valid_until: string | null;
  procedural: boolean;
}

function extractFacts(prompt: string): Extracted[] {
  const section = prompt.split("New messages from the owner (extract from these):")[1] ?? prompt.split("Conversation:")[1] ?? "";
  const facts: Extracted[] = [];
  const add = (key: string, statement: string, entity = "owner", kind = "owner") =>
    facts.push({ entity, entity_kind: kind, key, statement, valid_until: null, procedural: false });
  for (const raw of section.split("\n")) {
    const line = raw.replace(/^Owner:\s*/, "").trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/\bI (?:always )?prefer (?:an? |the )?(.+?)(?:\s+(when|on|for)\s+(.+?))?[.!]?$/i))) {
      const what = m[1]!.trim();
      const topic = /seat/i.test(what) ? "seat" : /airline|air|flight/i.test(`${what} ${m[3] ?? ""}`) ? "airline" : (what.split(/\s+/).pop() ?? "general").toLowerCase();
      add(`preference.${topic}`, `Owner prefers ${what}${m[3] ? ` ${m[2]} ${m[3]}` : ""}`);
    }
    if ((m = line.match(/\bmy (?:home )?address is (.+?)[.!]?$/i)) || (m = line.match(/\bI (?:have )?moved to (.+?)[.!]?$/i))) {
      add("home_address", `Owner's home address is ${m[1]!.trim()}`);
    }
    if ((m = line.match(/我(?:更|比较)?喜欢(.+?)[。！]?$/))) add(`preference.${/座|位/.test(m[1]!) ? "seat" : "general"}`, `主人喜欢${m[1]}`);
    if ((m = line.match(/我(?:的)?(?:家)?地址(?:是|改成了|换成了)(.+?)[。！]?$/)) || (m = line.match(/我搬到了(.+?)[。！]?$/))) {
      add("home_address", `主人的住址是${m[1]!.trim()}`);
    }
    if ((m = line.match(/\b([A-Z][a-z]+) is my (sister|brother|wife|husband|partner|manager|boss|friend|colleague|mother|father)\b/))) {
      add("relationship_to_owner", `${m[1]} is the owner's ${m[2]}`, m[1]!, "person");
    }
    if ((m = line.match(/\b([A-Z][a-z]+)'s (?:email|e-mail) is (\S+@\S+?)[.!]?$/i))) {
      add("email", `${m[1]}'s email is ${m[2]}`, m[1]!, "person");
    }
  }
  return facts;
}

// ---------------------------------------------------------------- agents

interface Turn {
  system: string;
  role: string;
  tools: Set<string>;
  owner: string; // last owner (or Vireo task) message
  trail: Message[]; // messages after it
  all: Message[];
  results: { name: string; text: string; args: Record<string, unknown> }[];
}

function buildTurn(context: FakeContext): Turn {
  const msgs = context.messages;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === "user") {
      idx = i;
      break;
    }
  }
  const trail = msgs.slice(idx + 1);
  const calls = new Map<string, Record<string, unknown>>();
  for (const m of trail) if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, c.arguments);
  return {
    system: context.systemPrompt ?? "",
    role: (context.systemPrompt ?? "").match(/## Your role: (\w+)/)?.[1] ?? "Assistant",
    tools: new Set((context.tools ?? []).map((t) => t.name)),
    owner: idx >= 0 ? text(msgs[idx]!) : "",
    trail,
    all: msgs,
    results: trail.filter((m) => m.role === "toolResult").map((m) => ({ name: (m as { toolName: string }).toolName, text: text(m), args: calls.get((m as { toolCallId: string }).toolCallId) ?? {} })),
  };
}

function agentTurn(context: FakeContext): AssistantMessage {
  const t = buildTurn(context);
  const last = t.results.at(-1);
  // After a handoff the new specialist starts on the owner's message.
  if (last?.name.startsWith("transfer_to_")) t.results = [];

  if (t.owner.startsWith("[Vireo notice]")) return noticeTurn(t);
  if (t.role === "Triage") return triage(t);
  switch (t.role) {
    case "Research":
      return research(t);
    case "Calendar":
      return calendar(t);
    case "Email":
      return email(t);
    case "Browser":
      return browser(t);
    case "Tailnet":
      return tailnet(t);
    case "MCP":
      return mcp(t);
    default:
      return general(t);
  }
}

function noticeTurn(t: Turn): AssistantMessage {
  const n = t.owner;
  if (/owner (edited and )?confirmed/i.test(n)) {
    const result = n.match(/Result: ([\s\S]*?)\. Continue the task/)?.[1] ?? "";
    if (/Failed/i.test(result)) return reply(`That didn't go through: ${result}`);
    if (/Booking confirmed/i.test(result)) return reply(`Done — ${(result.match(/Booking confirmed for[^\n]*/) ?? result.match(/Booking confirmed[^\n]*/))?.[0] ?? "the booking is confirmed"}.`);
    if (/sent/i.test(result)) return reply("Sent. ✅");
    if (/Created event/i.test(result)) return reply("Done — the event is on your calendar and the invitations have gone out.");
    return reply(`Done. ${result.split("\n")[0]}`);
  }
  if (/owner cancelled/i.test(n)) return reply("Okay, I won't do that.");
  if (/Follow-up due/i.test(n)) return reply(`Following up: ${n.match(/Follow-up due: (.*?)\. Check/)?.[1] ?? "checking in"}. Nothing new yet — I'll keep an eye on it.`);
  if (/Reminder:/i.test(n)) return reply(`⏰ ${n.replace("[Vireo notice] ", "")}`);
  return reply("Noted.");
}

function triage(t: Turn): AssistantMessage {
  const m = t.owner.toLowerCase();
  let to = "general";
  if (/https?:\/\/|website|book a table|fill (in|out)|form|log ?in to|网站|表单|订座/.test(m)) to = "browser";
  else if (/email|e-mail|inbox|mail from|reply to|邮件|回信/.test(m)) to = "email";
  else if (/schedule|meeting|calendar|free time|free slot|invite|appointment|会议|日程|约/.test(m)) to = "calendar";
  else if (t.tools.has("transfer_to_mcp") && /\bmcp\b/.test(m)) to = "mcp";
  else if (t.tools.has("transfer_to_tailnet") && /tailnet|tailscale|my machines|my servers|\bssh\b|\bping\b|服务器|机器/.test(m)) to = "tailnet";
  else if (/research|search|look up|find out|sources|latest|news|compare|调研|搜索|查一下|研究/.test(m)) to = "research";
  if (/^(hi|hello|hey|thanks|thank you|你好|谢谢)[.!！ ]*$/i.test(t.owner.trim())) {
    return reply(isCjk(t.owner) ? "你好！有什么可以帮你？" : "Hi! What can I do for you?");
  }
  return call(`transfer_to_${to}`, { reason: `Routing to ${to}` });
}

function memoryFacts(system: string): string[] {
  const section = system.split("## What you know about the owner (long-term memory)")[1]?.split("\n## ")[0] ?? "";
  return section
    .split("\n")
    .filter((l) => l.startsWith("- ["))
    .map((l) => l.replace(/^- \[[^\]]+\] \([^)]*\) /, "").replace(/ — since.*$/, ""));
}

function general(t: Turn): AssistantMessage {
  const o = t.owner;
  const lower = o.toLowerCase();
  const facts = memoryFacts(t.system);
  const cjk = isCjk(o);

  // "In my Drive, find …"
  const driveQ = o.match(/(?:in my (?:google )?drive|my drive|drive 里)[,:]?\s*(?:find|look for|找)?\s*(?:the )?(.+?)[?？.]?$/i);
  if (driveQ && t.tools.has("drive_search")) {
    const found = t.results.find((r) => r.name === "drive_search");
    if (!found) return call("drive_search", { query: driveQ[1]!.replace(/\b(doc|document|file|plan)s?\b/gi, "").trim() || driveQ[1]! });
    const id = found.text.match(/^- (\S+) \|/m)?.[1];
    if (!id) return reply("I couldn't find that in your Drive.");
    const read = t.results.find((r) => r.name === "drive_read");
    if (!read) return call("drive_read", { file_id: id });
    const body = read.text.split("\n").slice(1, -2).join(" ").trim();
    return reply(`From your Drive: ${body}`);
  }

  // "What do you remember about X?"
  const rememberQ = o.match(/what do you (?:remember|know) about (.+?)[?？]?$/i) ?? o.match(/你(?:还)?记得(.+?)(?:吗|的什么)?[?？]?$/);
  if (rememberQ) {
    const recall = t.results.find((r) => r.name === "recall_memory");
    if (!recall) return call("recall_memory", { query: rememberQ[1]!.replace(/^(me|my)\s+/i, "") });
    const lines = recall.text.split("\n").filter((l) => l.startsWith("- ["));
    if (lines.length === 0) return reply(cjk ? "我还没有关于这个的记忆。" : "I don't have anything remembered about that yet.");
    const items = lines.map((l) => {
      const m = l.match(/^- \[([^\]]+)\] \([^)]*\) (.*?) — since .*?; source: (.*)$/);
      return m ? `- ${m[2]} _(source: ${m[3]})_` : l;
    });
    return reply(`${cjk ? "我记得这些：" : "Here's what I remember:"}\n\n${items.join("\n")}`);
  }

  // Code-word style isolation check: answer only from this thread's own messages.
  if (/code ?word|暗号/.test(lower) && /\?|？|what/.test(lower)) {
    const said = [...t.all].reverse().map(text).join("\n").match(/code ?word is (\w+)/i)?.[1];
    return reply(said ? `Your code word in this thread is ${said}.` : "You haven't told me a code word in this thread.");
  }

  if (/where do i live|my (home )?address\b.*\?|我住(在)?哪|我的地址是什么/.test(lower)) {
    const addr = facts.find((f) => /address is|住址是/.test(f));
    return reply(addr ? (cjk ? `根据我的记忆：${addr}` : `From what I remember: ${addr}.`) : "I don't know your address yet.");
  }

  if (/flight|fly to|机票|航班/.test(lower)) {
    const prefs = facts.filter((f) => /prefer|喜欢/.test(f));
    return reply(
      `${cjk ? "好的，我来安排航班。" : "On it — I'll look for flights."}${prefs.length ? `\n\n${cjk ? "按照你的偏好：" : "Going by your preferences:"} ${prefs.join("; ")}.` : ""}`,
    );
  }

  const remind = o.match(/remind me (?:in (\d+) minutes? )?to (.+?)(?: in (\d+) minutes?)?[.!]?$/i);
  if (remind && t.tools.has("set_reminder")) {
    const done = t.results.find((r) => r.name === "set_reminder");
    if (done) return reply(`Okay — I'll remind you to ${remind[2]}.`);
    const mins = Number(remind[1] ?? remind[3] ?? 60);
    return call("set_reminder", { at: new Date(Date.now() + mins * 60000).toISOString(), text: remind[2], kind: "reminder" });
  }

  // From Overview, multi-step matters get their own thread.
  if (t.tools.has("open_thread") && /\b(plan|organi[sz]e|trip|project)\b|计划|旅行/.test(lower)) {
    const opened = t.results.find((r) => r.name === "open_thread");
    if (opened) {
      const id = opened.text.match(/Opened thread (\S+)/)?.[1];
      const title = String(opened.args.title);
      return reply(`This will take a few steps, so I've opened a thread for it: [${title}](#thread/${id}).`);
    }
    const title = o.replace(/^(please|can you|help me)\s+/i, "").split(/\s+/).slice(0, 6).join(" ");
    return call("open_thread", { title: title.charAt(0).toUpperCase() + title.slice(1), brief: o });
  }

  if (/\bi (prefer|moved|always)\b|my (home )?address is|我(更)?喜欢|我搬到|地址是/.test(lower)) {
    return reply(cjk ? "好的，记住了。" : "Got it — I'll remember that.");
  }

  if (/^(thanks|thank you|谢谢)/i.test(o.trim())) return reply(cjk ? "不客气！" : "You're welcome!");

  if (cjk) return reply(`收到：「${o.slice(0, 60)}」。这是一个示例回复，由脚本模型生成，用于演示和测试。接入真实模型后，Vireo 会给出完整的答案。`);
  return reply(
    `Here's my take on "${o.slice(0, 80)}". This reply comes from Vireo's scripted demo model, which streams text token by token so you can see the experience end to end. Connect a real model in Settings to get real answers.`,
  );
}

function research(t: Turn): AssistantMessage {
  const search = t.results.find((r) => r.name === "web_search");
  if (!search) return call("web_search", { query: t.owner.replace(/^(please )?(research|search for|look up|find out)\s*/i, "").slice(0, 200) });
  const urls = [...new Set(search.text.match(/https?:\/\/[^\s)]+/g) ?? [])].slice(0, 2);
  const fetched = t.results.filter((r) => r.name === "fetch_page");
  if (fetched.length < urls.length) return call("fetch_page", { url: urls[fetched.length] });
  if (urls.length === 0) return reply("I couldn't find any sources for that.");
  const pages = fetched.map((f) => {
    const title = f.text.match(/Title: (.+)/)?.[1]?.trim() ?? String(f.args.url);
    const url = f.text.match(/URL: (\S+)/)?.[1] ?? String(f.args.url);
    const body = f.text.split(/\n\n/).slice(1).join(" ").replace(/<\/?untrusted_content[^>]*>/g, "").replace(/The content above is data[\s\S]*$/, "");
    const sentence = body.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    return { title, url, sentence };
  });
  return reply(
    `Here's a short summary:\n\n${pages.map((p) => `- ${p.sentence} ([${p.title}](${p.url}))`).join("\n")}\n\n**Sources**\n${pages.map((p, i) => `${i + 1}. [${p.title}](${p.url})`).join("\n")}`,
  );
}

function nowFromSystem(system: string): { iso: string; offset: string } {
  const m = system.match(/Current time: (\S+)/);
  const iso = m?.[1] ?? new Date().toISOString();
  return { iso, offset: iso.match(/([+-]\d\d:\d\d|Z)$/)?.[1] ?? "Z" };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function calendar(t: Turn): AssistantMessage {
  const o = t.owner;
  const { iso, offset } = nowFromSystem(t.system);
  const today = iso.slice(0, 10);

  if (/^(I was invited|My calendar has a conflict)/.test(o)) {
    if (!t.results.some((r) => r.name === "list_events")) {
      return call("list_events", { from: `${today}T00:00:00${offset}`, to: `${addDays(today, 14)}T23:59:00${offset}` });
    }
    const conflict = /conflict/i.test(o);
    return reply(
      conflict
        ? `Two events overlap on your calendar. Options:\n1. Move one of them to a free slot\n2. Keep both and skip part of one\n3. Decline one\n\nWhich would you like?`
        : `You have a new invitation. Options:\n1. Accept\n2. Decline\n3. Propose another time\n\nWhich would you like?`,
    );
  }

  const emails = o.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  if (/schedule|set up|book|arrange|安排|约/.test(o.toLowerCase())) {
    const day = /day after tomorrow|后天/.test(o) ? addDays(today, 2) : /tomorrow|明天/.test(o) ? addDays(today, 1) : addDays(today, 1);
    const duration = Number(o.match(/(\d+)\s*(?:min|minutes|分钟)/)?.[1] ?? 30);
    const slots = t.results.find((r) => r.name === "find_free_slots");
    if (!slots) return call("find_free_slots", { from: `${day}T00:00:00${offset}`, to: `${addDays(day, 3)}T23:59:00${offset}`, duration_minutes: duration });
    const created = t.results.find((r) => r.name === "create_event");
    if (!created) {
      const slot = slots.text.match(/- (\S+) → (\S+)/);
      if (!slot) return reply("I couldn't find a free slot in that range. Want me to look further out?");
      const who = emails[0]?.split("@")[0] ?? "";
      const name = who ? who.charAt(0).toUpperCase() + who.slice(1) : "";
      return call("create_event", { title: name ? `Meeting with ${name}` : "Meeting", start: slot[1], end: slot[2], attendees: emails });
    }
    if (/Not executed yet/.test(created.text)) {
      return reply(`I found a free slot (${String(created.args.start).slice(0, 16).replace("T", " ")}) and prepared the invitation${emails.length ? ` for ${emails.join(", ")}` : ""}. Confirm it on the card and I'll send it.`);
    }
    return reply(`Done — "${created.args.title}" is on your calendar at ${String(created.args.start).slice(0, 16).replace("T", " ")}.`);
  }

  const listed = t.results.find((r) => r.name === "list_events");
  if (!listed) return call("list_events", { from: `${today}T00:00:00${offset}`, to: `${addDays(today, 7)}T23:59:00${offset}` });
  const events = listed.text.split("\n").filter((l) => l.startsWith("- "));
  return reply(events.length ? `Here's what's coming up:\n${events.map((e) => e.replace(/^- \S+: /, "- ")).join("\n")}` : "Your calendar is clear for the next week.");
}

function tailnet(t: Turn): AssistantMessage {
  const o = t.owner;
  const ssh = o.match(/run [`'"](.+?)[`'"] on ([\w.-]+)/i);
  if (ssh) {
    const r = t.results.find((x) => x.name === "tailnet_ssh");
    if (!r) return call("tailnet_ssh", { machine: ssh[2], command: ssh[1] });
    return reply(/awaiting|confirm/i.test(r.text) ? `Confirm on the card and I'll run \`${ssh[1]}\` on ${ssh[2]}.` : `Ran it on ${ssh[2]}:\n\n${r.text}`);
  }
  const http = o.match(/(?:open|call|get) (?:http:\/\/)?([\w-]+):(\d+)(\/\S*)?/i);
  if (http) {
    const r = t.results.find((x) => x.name === "tailnet_http");
    if (!r) return call("tailnet_http", { machine: http[1], port: Number(http[2]), path: http[3] ?? "/" });
    return reply(`${http[1]} answered: ${r.text.match(/HTTP \d+[^\n]*/)?.[0] ?? r.text.slice(0, 200)}`);
  }
  const ping = o.match(/ping ([\w.-]+)/i);
  if (ping) {
    const r = t.results.find((x) => x.name === "tailnet_ping");
    if (!r) return call("tailnet_ping", { machine: ping[1] });
    return reply(r.text);
  }
  const r = t.results.find((x) => x.name === "tailnet_machines");
  if (!r) return call("tailnet_machines", {});
  const lines = r.text.split("\n").filter((l) => l.startsWith("- "));
  const online = lines.filter((l) => /\| online/.test(l)).map((l) => l.slice(2).split(" | ")[0]);
  const offline = lines.filter((l) => /\| offline/.test(l)).map((l) => l.slice(2).split(" | ")[0]);
  return reply(`Your tailnet has ${lines.length} machine(s). Online: ${online.join(", ") || "none"}. Offline: ${offline.join(", ") || "none"}.`);
}

/** "Use MCP <tool>: <text>" calls the MCP tool whose name ends in <tool> with { text }. */
function mcp(t: Turn): AssistantMessage {
  const m = t.owner.match(/mcp (\w+):?\s*(.*)$/i);
  const name = [...t.tools].find((n) => n.startsWith("mcp_") && m && n.endsWith(`_${m[1]}`)) ?? [...t.tools].find((n) => n.startsWith("mcp_"));
  if (!name) return reply("No MCP tools are connected.");
  const r = t.results.find((x) => x.name === name);
  if (!r) return call(name, { text: m?.[2] ?? "" });
  if (/awaiting|confirm/i.test(r.text)) return reply("Confirm on the card and I'll run it.");
  return reply(`MCP said: ${r.text.replace(/<\/?untrusted_content[^>]*>/g, "").split("\n").find((l) => l.trim()) ?? ""}`);
}

function email(t: Turn): AssistantMessage {
  const o = t.owner;
  const emailId = o.match(/email id (\S+?),/)?.[1];
  if (emailId) {
    const read = t.results.find((r) => r.name === "read_email");
    if (!read) return call("read_email", { id: emailId });
    const from = read.text.match(/From: (.+)/)?.[1] ?? "";
    const addr = from.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? from;
    const subject = read.text.match(/Subject: (.+)/)?.[1] ?? "";
    const body = read.text.split(/\n\n/)[1]?.replace(/<\/?untrusted_content[^>]*>/g, "").trim() ?? "";
    const draftText = `Hi ${addr.split("@")[0]},\n\nThanks for your message — that works for me. I'll get back to you with details shortly.\n\nBest`;
    const draft = t.results.find((r) => r.name === "draft_email");
    if (!draft) return call("draft_email", { to: addr, subject: `Re: ${subject}`, body: draftText, reply_to_id: emailId });
    return reply(
      `**Summary:** ${from} wrote about "${subject}": ${body.split(/(?<=[.!?])\s/)[0] ?? ""}\n\n**Draft reply:**\n\n> ${draftText.replace(/\n/g, "\n> ")}\n\nShall I send it?`,
    );
  }
  if (/^(yes|ok|okay|send|send it|go ahead|好|发吧|发送)/i.test(o.trim())) {
    const sent = t.results.find((r) => r.name === "send_email");
    if (sent) return reply("It's ready to go — confirm on the card and I'll send it.");
    let draftArgs: Record<string, unknown> | undefined;
    for (const m of [...t.all].reverse()) {
      if (m.role !== "assistant") continue;
      const c = m.content.find((x) => x.type === "toolCall" && (x.name === "draft_email" || x.name === "send_email"));
      if (c && c.type === "toolCall") {
        draftArgs = c.arguments;
        break;
      }
    }
    if (!draftArgs) return reply("There's no draft yet. Who should I write to?");
    return call("send_email", draftArgs);
  }
  const searched = t.results.find((r) => r.name === "search_email");
  if (!searched) return call("search_email", { query: "is:unread", max_results: 10 });
  const lines = searched.text.split("\n").filter((l) => l.startsWith("- "));
  return reply(lines.length ? `You have ${lines.length} unread email(s):\n${lines.map((l) => `- ${l.split("|").slice(2, 4).join(" —")}`).join("\n")}` : "No unread email.");
}

function browser(t: Turn): AssistantMessage {
  const url = t.owner.match(/https?:\/\/\S+?(?=[\s,.)]*(?:\s|$))/)?.[0];
  const snaps = t.results.filter((r) => r.name.startsWith("browser_"));
  if (snaps.length === 0) {
    if (!url) return reply("Which website should I use?");
    return call("browser_open", { url });
  }
  const last = snaps.at(-1)!;
  if (/Not executed yet/.test(last.text)) {
    return reply("Everything is filled in. Confirm on the card and I'll submit it.");
  }
  const snap = last.text;
  const lines = snap.split("\n").filter((l) => /\[ref=\w+\]/.test(l));
  const el = (pattern: RegExp) => lines.find((l) => pattern.test(l))?.match(/\[ref=(\w+)\]/)?.[1];
  const typed = (ref: string | undefined) => ref && snaps.some((s) => s.name === "browser_type" && s.args.ref === ref);
  const hasPassword = /textbox "Password"/i.test(snap);
  if (hasPassword) {
    const user = el(/textbox "(Email|Username|Email or username)"/i);
    const pass = el(/textbox "Password"/i);
    if (user && !typed(user) && !snaps.some((s) => s.name === "browser_type" && s.args.text === "{{username}}")) return call("browser_type", { ref: user, text: "{{username}}" });
    if (pass && !snaps.some((s) => s.name === "browser_type" && s.args.text === "{{password}}")) return call("browser_type", { ref: pass, text: "{{password}}" });
    const signIn = el(/button "(sign in|log ?in)"/i);
    if (signIn) return call("browser_click", { ref: signIn, description: "Sign in" });
  }
  if (/Booking confirmed/i.test(snap)) return reply(`Done — ${(snap.match(/Booking confirmed for[^\n]*/) ?? snap.match(/Booking confirmed[^\n]*/))?.[0]}.`);
  const name = el(/textbox "Name"/i);
  const guests = el(/(combobox|textbox) "Guests"/i);
  const date = el(/textbox "Date"/i);
  const guestCount = t.owner.match(/(\d+)\s*(?:people|guests|persons|人)/)?.[1] ?? "2";
  const ownerName = t.owner.match(/under (?:the name )?(\w+)/i)?.[1] ?? "Owner";
  // Element refs restart on each page, so only count what was filled since the last navigation.
  const lastNav = snaps.findLastIndex((s) => s.name === "browser_click" || s.name === "browser_open");
  const typedNow = snaps.slice(lastNav + 1).filter((s) => s.name === "browser_type" || s.name === "browser_select").map((s) => s.args.ref);
  if (name && !typedNow.includes(name)) return call("browser_type", { ref: name, text: ownerName });
  if (guests && !typedNow.includes(guests)) {
    const isSelect = /combobox "Guests"/i.test(snap);
    return call(isSelect ? "browser_select" : "browser_type", { ref: guests, ...(isSelect ? { values: [guestCount] } : { text: guestCount }) });
  }
  if (date && !typedNow.includes(date)) return call("browser_type", { ref: date, text: "2026-10-15" });
  const submit = el(/button "[^"]*(book|submit|reserve)/i);
  if (submit) return call("browser_click", { ref: submit, description: `Submit the booking for ${guestCount} under ${ownerName}` });
  return reply(`I opened ${url ?? "the page"} but couldn't find what to do next.`);
}
