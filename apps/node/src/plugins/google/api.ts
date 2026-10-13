import { now } from "../../util.js";
import type { PluginState } from "../types.js";
import type {
  CalendarEvent,
  CalendarProvider,
  DriveFile,
  DriveProvider,
  Email,
  EmailSummary,
  MailProvider,
  NewEvent,
  OutgoingEmail,
} from "../../integrations/types.js";

/**
 * Google Calendar, Gmail and Drive over Google's REST APIs. The OAuth client
 * is the owner's own when they created one in Google Cloud Console, else
 * Vireo's shared client, whose secret only the cloud holds: the cloud then
 * makes the token requests for this node. Tokens stay in this node's
 * database and are never passed to a model.
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  DRIVE_SCOPE,
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** How long the cloud's answer about its shared client is trusted. */
const SHARED_FRESH = 10 * 60_000;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** Vireo's shared client, as the cloud describes it: Google redirects to the cloud. */
export interface SharedClient {
  clientId: string;
  redirectUri: string;
}

/** Calls the cloud this node is linked to; undefined when it is not linked. */
export type CloudCall = (path: string, init?: RequestInit) => Promise<Response> | undefined;

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  email?: string;
  /** Space-separated scopes Google granted. */
  scope?: string;
  /** Issued to the shared client, so refreshed through the cloud. */
  shared?: boolean;
}

interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
}

export class GoogleAuth {
  private sharedCache: { at: number; client?: SharedClient } | undefined;

  constructor(
    private readonly state: PluginState,
    /** The OAuth client from the Google plugin's settings. */
    private readonly stored: () => GoogleClient | undefined,
    private readonly cloud: CloudCall = () => undefined,
  ) {}

  /** The owner's own client: from the plugin's settings, else the environment. */
  own(): GoogleClient | undefined {
    const stored = this.stored();
    if (stored?.clientId && stored.clientSecret) return stored;
    const id = process.env.GOOGLE_CLIENT_ID;
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    return id && secret ? { clientId: id, clientSecret: secret } : undefined;
  }

  /** The cloud's shared client; undefined when this node is not linked or its cloud has none. */
  async shared(): Promise<SharedClient | undefined> {
    const c = this.sharedCache;
    if (c && now() - c.at < SHARED_FRESH) return c.client;
    const call = this.cloud("/api/node/google");
    if (!call) {
      this.sharedCache = { at: now() };
      return undefined;
    }
    const res = await call.catch(() => undefined);
    // An unreachable cloud changes nothing; ask again next time.
    if (!res || res.status >= 500) return c?.client;
    const client = res.ok ? ((await res.json()) as SharedClient) : undefined;
    this.sharedCache = { at: now(), client };
    return client;
  }

  /** Whether a sign-in can start, as last known (status() checks the cloud). */
  available(): boolean {
    return Boolean(this.own() ?? this.sharedCache?.client);
  }

  granted(scope: string): boolean {
    const s = this.tokens()?.scope;
    return s === undefined ? false : s.split(" ").includes(scope);
  }

  tokens(): GoogleTokens | undefined {
    return this.state.get<GoogleTokens>("tokens");
  }

  connected(): boolean {
    return Boolean(this.tokens()?.refresh_token ?? this.tokens()?.access_token);
  }

  disconnect(): void {
    this.state.delete("tokens");
  }

  authUrl(clientId: string, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  /** Trades Google's code for tokens; `sharedState` when the sign-in used the shared client. */
  async exchange(code: string, redirectUri: string, sharedState?: string): Promise<void> {
    const body = sharedState
      ? await this.viaCloud("/api/node/google/token", { state: sharedState, code }, "token exchange")
      : await this.direct({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, "token exchange");
    let email: string | undefined;
    if (body.id_token) {
      try {
        email = JSON.parse(Buffer.from(body.id_token.split(".")[1]!, "base64url").toString()).email;
      } catch {
        // email is informational only
      }
    }
    this.state.set("tokens", {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: now() + body.expires_in * 1000,
      email,
      scope: body.scope,
      shared: sharedState ? true : undefined,
    } satisfies GoogleTokens);
  }

  async accessToken(): Promise<string> {
    const tokens = this.tokens();
    if (!tokens) throw new Error("Google is not connected. Connect it in Settings.");
    if (tokens.expires_at - 60_000 > now()) return tokens.access_token;
    if (!tokens.refresh_token || (!tokens.shared && !this.own())) throw new Error("Google session expired. Reconnect Google in Settings.");
    const body = tokens.shared
      ? await this.viaCloud("/api/node/google/refresh", { refresh_token: tokens.refresh_token }, "token refresh")
      : await this.direct({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, "token refresh");
    this.state.set("tokens", { ...tokens, access_token: body.access_token, expires_at: now() + body.expires_in * 1000 });
    return body.access_token;
  }

  /** A token request to Google with the owner's own client. */
  private async direct(params: Record<string, string>, what: string): Promise<TokenAnswer> {
    const client = this.own();
    if (!client) throw new Error("Google OAuth client is not configured");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    if (!res.ok) throw new Error(`Google ${what} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as TokenAnswer;
  }

  /** A token request the cloud makes with the shared client. */
  private async viaCloud(path: string, body: Record<string, string>, what: string): Promise<TokenAnswer> {
    const call = this.cloud(path, { method: "POST", body: JSON.stringify(body) });
    if (!call) throw new Error("This node is no longer linked to a Vireo cloud. Reconnect Google in Settings.");
    const res = await call;
    if (!res.ok) throw new Error(`Google ${what} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as TokenAnswer;
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

interface GEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string; self?: boolean; responseStatus?: string }[];
  location?: string;
  description?: string;
  organizer?: { email?: string };
  htmlLink?: string;
}

function toEvent(e: GEvent): CalendarEvent {
  const self = e.attendees?.find((a) => a.self);
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: e.start.dateTime ?? `${e.start.date}T00:00:00Z`,
    end: e.end.dateTime ?? `${e.end.date}T00:00:00Z`,
    attendees: (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email),
    location: e.location,
    description: e.description,
    organizer: e.organizer?.email,
    responseStatus: (self?.responseStatus as CalendarEvent["responseStatus"]) ?? "accepted",
    htmlLink: e.htmlLink,
  };
}

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export class GoogleCalendar implements CalendarProvider {
  readonly name = "Google Calendar";
  constructor(private readonly auth: GoogleAuth) {}

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const body = await this.auth.api<{ items: GEvent[] }>(`${CAL}?${params}`);
    return body.items.map(toEvent);
  }

  async createEvent(e: NewEvent): Promise<CalendarEvent> {
    const body = await this.auth.api<GEvent>(`${CAL}?sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        summary: e.title,
        start: { dateTime: e.start },
        end: { dateTime: e.end },
        attendees: (e.attendees ?? []).map((email) => ({ email })),
        location: e.location,
        description: e.description,
      }),
    });
    return toEvent(body);
  }

  async updateEvent(id: string, patch: Partial<NewEvent>): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (patch.title) body.summary = patch.title;
    if (patch.start) body.start = { dateTime: patch.start };
    if (patch.end) body.end = { dateTime: patch.end };
    if (patch.attendees) body.attendees = patch.attendees.map((email) => ({ email }));
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.description !== undefined) body.description = patch.description;
    return toEvent(await this.auth.api<GEvent>(`${CAL}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(body) }));
  }

  async deleteEvent(id: string): Promise<void> {
    await this.auth.api(`${CAL}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" });
  }

  async respond(id: string, response: "accepted" | "declined" | "tentative"): Promise<CalendarEvent> {
    const ev = await this.auth.api<GEvent>(`${CAL}/${encodeURIComponent(id)}`);
    const attendees = (ev.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
    return toEvent(
      await this.auth.api<GEvent>(`${CAL}/${encodeURIComponent(id)}?sendUpdates=all`, {
        method: "PATCH",
        body: JSON.stringify({ attendees }),
      }),
    );
  }
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  internalDate: string;
  payload: GPart & { headers: { name: string; value: string }[] };
}
interface GPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GPart[];
}

function header(m: GMessage, name: string): string {
  return m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function partText(p: GPart): string {
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const child of p.parts ?? []) {
    const t = partText(child);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    return Buffer.from(p.body.data, "base64url")
      .toString("utf8")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }
  return "";
}

function summary(m: GMessage): EmailSummary {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    subject: header(m, "Subject"),
    snippet: m.snippet,
    date: new Date(Number(m.internalDate)).toISOString(),
    unread: m.labelIds?.includes("UNREAD") ?? false,
  };
}

function encodeMail(mail: OutgoingEmail, inReplyTo?: string): string {
  const lines = [
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "",
    mail.body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export class GoogleMail implements MailProvider {
  readonly name = "Gmail";
  constructor(private readonly auth: GoogleAuth) {}

  private async fetchMessage(id: string, format: "metadata" | "full"): Promise<GMessage> {
    return this.auth.api<GMessage>(`${GMAIL}/messages/${id}?format=${format}`);
  }

  async search(query: string, max: number): Promise<EmailSummary[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 25)) });
    const list = await this.auth.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${params}`);
    const out: EmailSummary[] = [];
    for (const m of list.messages ?? []) out.push(summary(await this.fetchMessage(m.id, "metadata")));
    return out;
  }

  async get(id: string): Promise<Email> {
    const m = await this.fetchMessage(id, "full");
    return { ...summary(m), body: partText(m.payload).slice(0, 20000), messageIdHeader: header(m, "Message-ID") };
  }

  async newInbox(sinceMs: number): Promise<EmailSummary[]> {
    const after = Math.floor(sinceMs / 1000);
    return this.search(`in:inbox is:unread category:primary after:${after}`, 20);
  }

  private async replyMeta(mail: OutgoingEmail): Promise<{ threadId?: string; inReplyTo?: string }> {
    if (!mail.replyToId) return {};
    const orig = await this.get(mail.replyToId);
    return { threadId: orig.threadId, inReplyTo: orig.messageIdHeader };
  }

  async createDraft(mail: OutgoingEmail): Promise<{ id: string }> {
    const meta = await this.replyMeta(mail);
    const body = await this.auth.api<{ id: string }>(`${GMAIL}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw: encodeMail(mail, meta.inReplyTo), threadId: meta.threadId } }),
    });
    return { id: body.id };
  }

  async send(mail: OutgoingEmail): Promise<{ id: string }> {
    const meta = await this.replyMeta(mail);
    const body = await this.auth.api<{ id: string }>(`${GMAIL}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw: encodeMail(mail, meta.inReplyTo), threadId: meta.threadId }),
    });
    return { id: body.id };
  }

  async ownerAddress(): Promise<string | undefined> {
    return this.auth.tokens()?.email;
  }
}

const DRIVE = "https://www.googleapis.com/drive/v3/files";

/** Export formats for Google's own document types. */
const EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export class GoogleDrive implements DriveProvider {
  constructor(private readonly auth: GoogleAuth) {}

  async search(query: string, max: number): Promise<DriveFile[]> {
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const params = new URLSearchParams({
      q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
      pageSize: String(Math.min(max, 25)),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
      orderBy: "modifiedTime desc",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    return (await this.auth.api<{ files: DriveFile[] }>(`${DRIVE}?${params}`)).files;
  }

  async read(id: string): Promise<{ file: DriveFile; text: string }> {
    const fid = encodeURIComponent(id);
    const file = await this.auth.api<DriveFile>(`${DRIVE}/${fid}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`);
    const exportAs = EXPORT[file.mimeType];
    let url: string;
    if (exportAs) url = `${DRIVE}/${fid}/export?mimeType=${encodeURIComponent(exportAs)}`;
    else if (/^text\/|json|xml|csv|markdown/.test(file.mimeType)) url = `${DRIVE}/${fid}?alt=media&supportsAllDrives=true`;
    else return { file, text: `(${file.mimeType} files cannot be read as text. Open it at ${file.webViewLink ?? "Google Drive"}.)` };
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.auth.accessToken()}` } });
    if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { file, text: (await res.text()).slice(0, 40_000) };
  }
}
