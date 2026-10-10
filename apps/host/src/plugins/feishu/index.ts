import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { errorMessage } from "../../util.js";
import { ChatBridge, type OutMessage, type Transport } from "../chat.js";
import type { PluginDef, PluginStatus, RequestInfo } from "../types.js";

/**
 * Feishu / Lark: talk to Vireo from a Feishu or Lark bot. Messages arrive as
 * event subscriptions on a webhook, so the host must be reachable from the
 * internet (a public URL, a tunnel, or `tailscale funnel`). Only chats linked
 * with a one-time code are answered.
 */

interface FsConfig {
  region: "feishu" | "lark";
  app_id: string;
  app_secret: string;
  verification_token: string;
  encrypt_key: string;
}

const EVENTS = "/api/plugins/feishu/events";

interface FsEvent {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: { event_id: string; event_type: string; token: string };
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; parent_id?: string };
    operator?: { open_id?: string };
    action?: { value?: { data?: string } };
    context?: { open_chat_id?: string; open_message_id?: string };
  };
}

export function decryptFeishu(encrypted: string, key: string): string {
  const buf = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

class FeishuApi {
  private token?: { value: string; until: number };

  constructor(
    private readonly base: string,
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await fetch(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) throw new Error(`Feishu sign-in failed: ${data.msg ?? res.status}`);
    this.token = { value: data.tenant_access_token, until: Date.now() + Math.max(60, (data.expire ?? 7200) - 300) * 1000 };
    return this.token.value;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/open-apis${path}`, {
      method,
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${await this.tenantToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T };
    if (data.code !== 0) throw new Error(`Feishu ${path}: ${data.msg ?? res.status}`);
    return data.data as T;
  }

  async bot(): Promise<{ app_name: string; open_id: string }> {
    const res = await fetch(`${this.base}/open-apis/bot/v3/info`, { headers: { authorization: `Bearer ${await this.tenantToken()}` }, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; bot?: { app_name: string; open_id: string } };
    if (data.code !== 0 || !data.bot) throw new Error(`Feishu bot info: ${data.msg ?? res.status}`);
    return data.bot;
  }
}

/** Text, or a card with buttons when there are any. */
function feishuBody(chatId: string, msg: OutMessage) {
  if (!msg.buttons) return { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: msg.text }) };
  const card = {
    schema: "2.0",
    body: {
      elements: [
        { tag: "markdown", content: msg.text.replace(/[*_~`[\]<>]/g, (c) => `\\${c}`) },
        {
          tag: "column_set",
          columns: msg.buttons.flat().map((b, i) => ({
            tag: "column",
            width: "auto",
            elements: [{ tag: "button", text: { tag: "plain_text", content: b.label }, type: i === 0 ? "primary" : "default", behaviors: [{ type: "callback", value: { data: b.data } }] }],
          })),
        },
        { tag: "markdown", content: "Or reply /confirm or /cancel.", text_size: "notation" },
      ],
    },
  };
  return { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) };
}

export const feishuPlugin: PluginDef = {
  id: "feishu",
  name: "Feishu / Lark",
  description: "Talk to Vireo from a Feishu or Lark bot: threads, replies, reminders and confirmations. Needs the host reachable from the internet for events.",
  author: "Vireo community",
  homepage: "https://open.feishu.cn/app",
  fields: [
    {
      key: "region",
      label: "Platform",
      type: "select",
      default: "feishu",
      options: [
        { value: "feishu", label: "Feishu (open.feishu.cn)" },
        { value: "lark", label: "Lark (open.larksuite.com)" },
      ],
    },
    { key: "app_id", label: "App ID", type: "text", placeholder: "cli_…", help: "Create a custom app with the Bot feature, and grant it im:message and im:message:send_as_bot." },
    { key: "app_secret", label: "App secret", type: "secret" },
    { key: "verification_token", label: "Verification token", type: "secret", help: "Events & callbacks → Encryption strategy." },
    { key: "encrypt_key", label: "Encrypt key", type: "secret", help: "Optional, but recommended: events are encrypted and signed." },
  ],
  create(ctx) {
    const cfg = () => ctx.config<FsConfig>();
    let client: FeishuApi | undefined;
    let clientKey = "";
    const api = () => {
      const c = cfg();
      if (!c.app_id || !c.app_secret) return undefined;
      const base = process.env.VIREO_FEISHU_API_URL || (c.region === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
      const key = `${base}|${c.app_id}|${c.app_secret}`;
      if (!client || key !== clientKey) {
        client = new FeishuApi(base, c.app_id, c.app_secret);
        clientKey = key;
      }
      return client;
    };
    const transport = (): Transport | undefined => {
      const a = api();
      if (!a) return undefined;
      return {
        maxLength: 4000,
        async send(chatId, msg) {
          const r = await a.call<{ message_id: string }>("POST", "/im/v1/messages?receive_id_type=chat_id", feishuBody(chatId, msg));
          return r.message_id;
        },
      };
    };
    const bridge = new ChatBridge(ctx, transport);
    let bot: { app_name: string } | undefined;
    let lastError = "";
    let lastEventAt = 0;
    const seen: string[] = [];

    async function onEvent(e: FsEvent): Promise<Record<string, unknown>> {
      const type = e.header?.event_type;
      if (type === "im.message.receive_v1") {
        const m = e.event?.message;
        if (!m || m.chat_type !== "p2p") return {};
        let text = "";
        try {
          text = m.message_type === "text" ? (JSON.parse(m.content) as { text: string }).text : "";
        } catch {
          text = "";
        }
        if (!text) {
          await transport()?.send(m.chat_id, { text: "I can read text messages for now." });
          return {};
        }
        await bridge.receive({ chatId: m.chat_id, sender: e.event?.sender?.sender_id?.open_id, text, replyTo: m.parent_id || undefined });
        return {};
      }
      if (type === "card.action.trigger") {
        const chatId = e.event?.context?.open_chat_id ?? "";
        const note = await bridge.callback(chatId, e.event?.action?.value?.data ?? "");
        return note ? { toast: { type: "info", content: note.slice(0, 100) } } : {};
      }
      return {};
    }

    return {
      tools: [],
      async start() {
        lastError = "";
        bot = undefined;
        const a = api();
        if (!a) return;
        bot = await a.bot().catch((err: Error) => {
          lastError = err.message;
          return undefined;
        });
        bridge.start();
      },
      async stop() {
        bridge.stop();
      },
      async status(req?: RequestInfo): Promise<PluginStatus> {
        const c = cfg();
        const url = `${ctx.host.publicUrl(req)}${EVENTS}`;
        const details = [
          { label: "Event URL", value: url },
          { label: "Events", value: "im.message.receive_v1, card.action.trigger" },
          { label: "Linked chats", value: bridge.chats().length ? String(bridge.chats().length) : "none" },
        ];
        if (!c.app_id || !c.app_secret || !c.verification_token) return { state: "setup", message: "Enter the app's ID, secret and verification token, then set the event URL below in the developer console.", details };
        if (!bot) return { state: "error", message: lastError || "Could not reach Feishu.", details };
        if (bridge.chats().length === 0) {
          return { state: "login", message: `Press Link a chat, then send the code to ${bot.app_name} in a direct chat.${lastEventAt ? "" : " No events have arrived yet; check the event URL."}`, details };
        }
        return { state: "ready", message: `Connected as ${bot.app_name}.`, details };
      },
      actions() {
        return [{ id: "link", label: "Link a chat", primary: bridge.chats().length === 0 }, ...(bridge.chats().length ? [{ id: "unlink", label: "Unlink all chats" }] : [])];
      },
      async runAction(id) {
        if (id === "link") return { message: `Send ${bridge.newLinkCode()} to ${bot?.app_name ?? "the bot"} in a direct chat within 10 minutes.` };
        if (id === "unlink") {
          bridge.unlinkAll();
          return { message: "Unlinked. The bot no longer answers any chat." };
        }
        throw new Error(`Unknown action: ${id}`);
      },
      // Feishu posts events here; each request is checked against the app's token (and signature when encrypted).
      publicRoutes(routes) {
        routes.post(EVENTS, async (c) => {
          if (!ctx.enabled()) return c.json({ error: "Not enabled" }, 404);
          const conf = cfg();
          const raw = await c.req.text();
          let body = JSON.parse(raw || "{}") as FsEvent & { encrypt?: string };
          if (conf.encrypt_key) {
            const ts = c.req.header("x-lark-request-timestamp");
            const nonce = c.req.header("x-lark-request-nonce");
            const sig = c.req.header("x-lark-signature");
            if (sig && ts && nonce) {
              const want = createHash("sha256").update(ts + nonce + conf.encrypt_key + raw).digest("hex");
              if (!same(sig, want)) return c.json({ error: "Bad signature" }, 401);
            }
            if (!body.encrypt) return c.json({ error: "Expected an encrypted event" }, 400);
            body = JSON.parse(decryptFeishu(body.encrypt, conf.encrypt_key)) as FsEvent;
          }
          const token = body.header?.token ?? body.token ?? "";
          if (!conf.verification_token || !same(token, conf.verification_token)) return c.json({ error: "Bad token" }, 401);
          if (body.type === "url_verification") return c.json({ challenge: body.challenge });
          lastEventAt = Date.now();
          // Feishu retries until it gets a 200; handle each event once.
          const id = body.header?.event_id;
          if (id) {
            if (seen.includes(id)) return c.json({});
            seen.push(id);
            seen.splice(0, Math.max(0, seen.length - 200));
          }
          if (body.header?.event_type === "card.action.trigger") return c.json(await onEvent(body));
          void onEvent(body).catch((err) => console.warn(`[feishu] ${errorMessage(err)}`));
          return c.json({});
        });
      },
      notify: (n) => bridge.notify(n),
      secrets() {
        const c = cfg();
        return [c.app_secret, c.verification_token, c.encrypt_key];
      },
    };
  },
};
