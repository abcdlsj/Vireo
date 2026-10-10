import { errorMessage } from "../../util.js";
import { ChatBridge, type OutMessage, type Transport } from "../chat.js";
import type { PluginDef, PluginStatus } from "../types.js";

/**
 * Telegram: talk to Vireo from Telegram through a bot of your own. Updates
 * arrive by long polling, so the host needs no public address. Only chats
 * linked with a one-time code are answered.
 */

interface TgConfig {
  bot_token: string;
  api_url: string;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number; username?: string; first_name?: string }; text?: string; caption?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number } }; data?: string };
}

class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly base: string,
  ) {}

  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  }
}

export const telegramPlugin: PluginDef = {
  id: "telegram",
  name: "Telegram",
  description: "Talk to Vireo from Telegram: threads, replies, reminders, and confirmations with buttons. Uses a bot you create with @BotFather.",
  author: "Vireo community",
  homepage: "https://t.me/BotFather",
  fields: [
    { key: "bot_token", label: "Bot token", type: "secret", placeholder: "123456:ABC-…", help: "Message @BotFather, send /newbot, and paste the token it gives you." },
    { key: "api_url", label: "Bot API server", type: "text", placeholder: "https://api.telegram.org", help: "Only for a self-hosted Bot API server." },
  ],
  create(ctx) {
    const { app } = ctx;
    const cfg = () => ctx.config<TgConfig>();
    const api = () => {
      const c = cfg();
      return c.bot_token ? new TelegramApi(c.bot_token, (c.api_url || process.env.VIREO_TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, "")) : undefined;
    };
    const transport = (): Transport | undefined => {
      const a = api();
      if (!a) return undefined;
      return {
        maxLength: 4000,
        async send(chatId: string, msg: OutMessage) {
          const r = await a.call<{ message_id: number }>("sendMessage", {
            chat_id: chatId,
            text: msg.text,
            link_preview_options: { is_disabled: true },
            reply_markup: msg.buttons ? { inline_keyboard: msg.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) } : undefined,
          });
          return String(r.message_id);
        },
      };
    };
    const bridge = new ChatBridge(app, "telegram", transport);

    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    let bot: { username: string } | undefined;
    let lastError = "";

    async function handle(a: TelegramApi, u: TgUpdate): Promise<void> {
      if (u.message) {
        const m = u.message;
        const text = m.text ?? m.caption ?? "";
        if (!text) return;
        if (m.chat.type !== "private") return; // only direct chats with the bot
        void a.call("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => undefined);
        await bridge.receive({ chatId: String(m.chat.id), sender: m.from?.username ?? m.from?.first_name, text, replyTo: m.reply_to_message ? String(m.reply_to_message.message_id) : undefined });
      } else if (u.callback_query) {
        const q = u.callback_query;
        const chatId = String(q.message?.chat.id ?? q.from.id);
        const note = await bridge.callback(chatId, q.data ?? "");
        await a.call("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => undefined);
        if (q.message) await a.call("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
    }

    async function poll(a: TelegramApi, signal: AbortSignal): Promise<void> {
      let offset = app.db.getKv<number>("telegram.offset") ?? 0;
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          const updates = await a.call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, AbortSignal.any([signal, AbortSignal.timeout(40_000)]));
          lastError = "";
          backoff = 1000;
          for (const u of updates) {
            offset = u.update_id + 1;
            app.db.setKv("telegram.offset", offset);
            await handle(a, u).catch((err) => console.warn(`[telegram] ${errorMessage(err)}`));
          }
        } catch (err) {
          if (signal.aborted) return;
          lastError = errorMessage(err);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    }

    return {
      tools: [],
      async start() {
        const a = api();
        if (!a) return;
        bot = await a.call<{ username: string }>("getMe").catch((err: Error) => {
          lastError = err.message;
          return undefined;
        });
        if (!bot) return;
        // Long polling and a webhook cannot both be active.
        await a.call("deleteWebhook").catch(() => undefined);
        await a
          .call("setMyCommands", {
            commands: [
              { command: "new", description: "Start a new thread" },
              { command: "threads", description: "Open threads" },
              { command: "overview", description: "Back to Overview" },
              { command: "help", description: "How this works" },
            ],
          })
          .catch(() => undefined);
        abort = new AbortController();
        loop = poll(a, abort.signal);
        bridge.start();
      },
      async stop() {
        bridge.stop();
        abort?.abort();
        await loop;
        abort = undefined;
        loop = undefined;
      },
      async status(): Promise<PluginStatus> {
        if (!cfg().bot_token) return { state: "setup", message: "Create a bot with @BotFather and paste its token in Settings." };
        if (!bot) return { state: "error", message: lastError || "Could not reach Telegram." };
        const chats = bridge.chats();
        const details = [
          { label: "Bot", value: `@${bot.username}` },
          { label: "Linked chats", value: chats.length ? chats.map((c) => c.sender ?? c.chatId).join(", ") : "none" },
        ];
        if (lastError) return { state: "error", message: `Polling failed: ${lastError}`, details };
        if (chats.length === 0) return { state: "login", message: `Press Link a chat, then send the code to @${bot.username}.`, details, link: { label: `Open @${bot.username}`, href: `https://t.me/${bot.username}` } };
        return { state: "ready", message: `Listening as @${bot.username}.`, details };
      },
      actions() {
        return [{ id: "link", label: "Link a chat", primary: bridge.chats().length === 0 }, ...(bridge.chats().length ? [{ id: "unlink", label: "Unlink all chats" }] : [])];
      },
      async runAction(id) {
        if (id === "link") {
          const code = bridge.newLinkCode();
          return { message: `Send /start ${code} to @${bot?.username ?? "your bot"} within 10 minutes.` };
        }
        if (id === "unlink") {
          bridge.unlinkAll();
          return { message: "Unlinked. The bot no longer answers any chat." };
        }
        throw new Error(`Unknown action: ${id}`);
      },
      notify: (n) => bridge.notify(n),
      secrets: () => [cfg().bot_token],
    };
  },
};
