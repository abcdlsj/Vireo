import type { App } from "../app.js";
import { bus } from "../bus.js";
import type { Notification } from "../push.js";
import { OVERVIEW_ID } from "../threads.js";
import { errorMessage, truncate } from "../util.js";
import { formatCode, normalizeCode } from "../pairing.js";
import { randomInt } from "node:crypto";

/**
 * What chat plugins (Telegram, Feishu) share: the owner talks to Vireo from a
 * chat app. Only chats the owner linked with a one-time code are listened to.
 * Each linked chat has a current thread (Overview to start with); replying to
 * one of Vireo's messages answers in that message's thread. Replies, questions,
 * confirmations and notifications come back to the chat.
 */

export interface ChatButton {
  label: string;
  /** Sent back as the callback when tapped. */
  data: string;
}

export interface OutMessage {
  text: string;
  /** Rows of buttons (Telegram inline keyboard; Feishu card buttons). */
  buttons?: ChatButton[][];
}

export interface Transport {
  /** Sends a message and returns its id in the chat, used to route replies. */
  send(chatId: string, msg: OutMessage): Promise<string | undefined>;
  /** Longest message the chat app accepts. */
  maxLength: number;
}

export interface Incoming {
  chatId: string;
  /** Who sent it; recorded at linking, informational. */
  sender?: string;
  text: string;
  /** Id of the message being replied to, if any. */
  replyTo?: string;
}

interface Linked {
  chatId: string;
  sender?: string;
  /** Current thread for this chat. */
  thread: string;
  linkedAt: number;
}

interface State {
  chats: Linked[];
  link?: { hash: string; expiresAt: number };
  /** Message id we sent → thread, newest last. */
  sent: [string, string][];
  /** Threads whose replies go to a chat, with the chat id. */
  watching: Record<string, string>;
}

const HELP = [
  "Talk to Vireo here. Messages go to the current thread (Overview to start with); reply to one of my messages to answer in its thread.",
  "/new <text> — start a new thread",
  "/overview — back to Overview",
  "/threads — open threads",
  "/open <n> — switch to thread n from /threads",
  "/confirm, /cancel — the newest confirmation in this thread",
].join("\n");

const LINK_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export class ChatBridge {
  private unsubscribe?: () => void;

  constructor(
    private readonly app: App,
    private readonly key: string,
    private readonly transport: () => Transport | undefined,
  ) {}

  private state(): State {
    const s = this.app.db.getKv<State>(`chat.${this.key}`);
    return { chats: s?.chats ?? [], link: s?.link, sent: s?.sent ?? [], watching: s?.watching ?? {} };
  }

  private save(s: State): void {
    s.sent = s.sent.slice(-500);
    this.app.db.setKv(`chat.${this.key}`, s);
  }

  chats(): Linked[] {
    return this.state().chats;
  }

  /** A one-time code the owner sends to the bot to link a chat (10 minutes). */
  newLinkCode(): string {
    let code = "";
    for (let i = 0; i < 8; i++) code += LINK_ALPHABET[randomInt(LINK_ALPHABET.length)];
    const s = this.state();
    s.link = { hash: normalizeCode(code), expiresAt: Date.now() + 10 * 60_000 };
    this.save(s);
    return formatCode(code);
  }

  unlinkAll(): void {
    this.save({ chats: [], sent: [], watching: {} });
  }

  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = bus.subscribe((e) => {
      if (e.type === "run.finished") void this.afterRun(e.threadId, e.text);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Handles a message from the chat app. Returns false if the chat is not linked (and was not just linked). */
  async receive(m: Incoming): Promise<boolean> {
    const s = this.state();
    const text = m.text.trim();
    let chat = s.chats.find((c) => c.chatId === m.chatId);
    if (!chat) {
      const code = normalizeCode(text.replace(/^\/start\s*/i, ""));
      if (s.link && s.link.expiresAt > Date.now() && code && code === s.link.hash) {
        chat = { chatId: m.chatId, sender: m.sender, thread: OVERVIEW_ID, linkedAt: Date.now() };
        s.chats.push(chat);
        s.link = undefined;
        this.save(s);
        await this.reply(m.chatId, `Linked. ${HELP}`);
        return true;
      }
      // Unknown chats get one line and nothing else: no threads, no names.
      if (/^\/start\b/i.test(text) || text.length <= 16) await this.reply(m.chatId, "This bot only answers its owner. Link this chat with the code from Vireo → Settings → Plugins.");
      return false;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    const arg = text.slice((cmd ?? "").length).trim();
    switch (cmd?.toLowerCase().replace(/@\S+$/, "")) {
      case "/help":
      case "/start":
        await this.reply(m.chatId, HELP);
        return true;
      case "/overview":
        this.setThread(m.chatId, OVERVIEW_ID);
        await this.reply(m.chatId, "Now in Overview.");
        return true;
      case "/new": {
        const t = this.app.threads.create({ origin: { kind: "chat", via: this.key } });
        this.setThread(m.chatId, t.id);
        if (arg) this.post(m.chatId, t.id, arg);
        else await this.reply(m.chatId, "New thread. What's it about?");
        return true;
      }
      case "/threads": {
        const open = this.openThreads();
        await this.reply(m.chatId, open.length ? open.map((t, i) => `${i + 1}. ${t.title}${t.needsYou ? " (needs you)" : ""}`).join("\n") : "No open threads.");
        return true;
      }
      case "/open": {
        const t = this.openThreads()[Number(rest[0]) - 1];
        if (!t) {
          await this.reply(m.chatId, "No such thread. Send /threads for the list.");
          return true;
        }
        this.setThread(m.chatId, t.id);
        await this.reply(m.chatId, `Now in “${t.title}”.${t.statusLine ? ` ${t.statusLine}` : ""}`);
        return true;
      }
      case "/confirm":
      case "/cancel": {
        const thread = this.threadFor(m);
        const action = this.app.actions.pending().filter((a) => a.threadId === thread).at(-1);
        if (!action) await this.reply(m.chatId, "Nothing is waiting for confirmation in this thread.");
        else await this.decide(m.chatId, action.id, cmd!.toLowerCase() === "/confirm");
        return true;
      }
    }

    const thread = this.threadFor(m);
    this.setThread(m.chatId, thread);
    this.post(m.chatId, thread, text);
    return true;
  }

  /** A tapped button: "act:<confirm|cancel>:<actionId>". */
  async callback(chatId: string, data: string): Promise<string> {
    if (!this.state().chats.some((c) => c.chatId === chatId)) return "Not linked.";
    const m = /^act:(confirm|cancel):(.+)$/.exec(data);
    if (!m) return "";
    return this.decide(chatId, m[2]!, m[1] === "confirm");
  }

  private async decide(chatId: string, actionId: string, confirm: boolean): Promise<string> {
    const before = this.app.actions.get(actionId);
    if (!before) return "That confirmation no longer exists.";
    if (before.status !== "pending") {
      const note = `Already ${before.status}: ${before.summary}`;
      await this.reply(chatId, note);
      return note;
    }
    this.watch(before.threadId, chatId);
    const after = confirm ? await this.app.actions.confirm(actionId) : this.app.actions.cancel(actionId);
    const note = `${confirm ? (after.status === "failed" ? "Failed" : "Confirmed") : "Cancelled"}: ${after.summary}`;
    await this.reply(chatId, note, before.threadId);
    return note;
  }

  private openThreads() {
    return this.app.threads.list().filter((t) => t.state === "active" && t.id !== OVERVIEW_ID && !t.temporary).slice(0, 20);
  }

  private threadFor(m: Incoming): string {
    const s = this.state();
    if (m.replyTo) {
      const hit = s.sent.find(([id]) => id === m.replyTo);
      if (hit && this.app.threads.get(hit[1])) return hit[1];
    }
    const cur = s.chats.find((c) => c.chatId === m.chatId)?.thread ?? OVERVIEW_ID;
    return this.app.threads.get(cur) ? cur : OVERVIEW_ID;
  }

  private setThread(chatId: string, thread: string): void {
    const s = this.state();
    const c = s.chats.find((x) => x.chatId === chatId);
    if (c) c.thread = thread;
    this.save(s);
  }

  private watch(threadId: string, chatId: string): void {
    const s = this.state();
    s.watching[threadId] = chatId;
    this.save(s);
  }

  private post(chatId: string, threadId: string, text: string): void {
    this.watch(threadId, chatId);
    this.app.runner.send(threadId, text);
  }

  /** Sends a run's answer to the chat that asked, unless it is waiting on a confirmation (that card comes separately). */
  private async afterRun(threadId: string, text: string): Promise<void> {
    const chatId = this.state().watching[threadId];
    if (!chatId || !text.trim()) return;
    const title = threadId === OVERVIEW_ID ? "" : this.app.threads.get(threadId)?.title;
    await this.reply(chatId, title ? `${text}\n\n— ${title}` : text, threadId);
  }

  /** Owner notifications: confirmations get buttons; the rest a short line. */
  notify(n: Notification): void {
    const s = this.state();
    if (s.chats.length === 0) return;
    const threadId = /#thread\/([^?&]+)/.exec(n.url ?? "")?.[1];
    const actionId = n.tag?.startsWith("action-") ? n.tag.slice(7) : undefined;
    // A run's own answer already reaches a watching chat through afterRun.
    if (!actionId && threadId && s.watching[threadId] && n.tag === threadId) return;
    const targets = threadId && s.watching[threadId] ? [s.watching[threadId]!] : s.chats.map((c) => c.chatId);
    const msg: OutMessage = {
      text: `${n.title}\n${n.body}`,
      buttons: actionId
        ? [
            [
              { label: "Confirm", data: `act:confirm:${actionId}` },
              { label: "Cancel", data: `act:cancel:${actionId}` },
            ],
          ]
        : undefined,
    };
    for (const chatId of targets) void this.sendTracked(chatId, msg, threadId);
  }

  private reply(chatId: string, text: string, threadId?: string): Promise<void> {
    return this.sendTracked(chatId, { text }, threadId);
  }

  private async sendTracked(chatId: string, msg: OutMessage, threadId?: string): Promise<void> {
    const t = this.transport();
    if (!t) return;
    const clean = this.app.vault.redact(msg.text);
    const parts = split(clean, t.maxLength);
    for (const [i, part] of parts.entries()) {
      try {
        const id = await t.send(chatId, { text: part, buttons: i === parts.length - 1 ? msg.buttons : undefined });
        if (id && threadId) {
          const s = this.state();
          s.sent.push([id, threadId]);
          this.save(s);
        }
      } catch (err) {
        console.warn(`[${this.key}] send failed: ${errorMessage(err)}`);
        return;
      }
    }
  }
}

/** Splits long text at paragraph or line breaks so each part fits. */
export function split(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest || out.length === 0) out.push(rest || truncate(text, max));
  return out;
}
