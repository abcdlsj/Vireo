import type { User } from "@vireo/protocol";
import type { CloudConfig } from "./config.js";
import type { Db } from "./db.js";
import { hash, newId, now, secret } from "./util.js";

const SESSION_TTL = 30 * 864e5;
const SIGN_IN_TTL = 10 * 60_000;

interface UserRow {
  id: string;
  github_id: number | null;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

const toUser = (r: UserRow): User => ({ id: r.id, login: r.login, name: r.name, avatarUrl: r.avatar_url });

/**
 * Accounts and app sessions. People sign in with GitHub; the cloud then hands
 * the app a one-time code in the redirect, which the app trades for a session
 * token it sends as a Bearer token (no cookies, so the app can live on any
 * origin).
 */
export class Accounts {
  constructor(
    private readonly db: Db,
    private readonly config: CloudConfig,
  ) {}

  user(id: string): User | undefined {
    const r = this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return r ? toUser(r) : undefined;
  }

  /** Creates or refreshes the account for a GitHub user. */
  upsertGithub(gh: { id: number; login: string; name: string | null; avatar_url: string | null }): User {
    const existing = this.db.get<UserRow>("SELECT * FROM users WHERE github_id = ?", gh.id);
    if (existing) {
      this.db.run("UPDATE users SET login = ?, name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?", gh.login, gh.name, gh.avatar_url, now(), existing.id);
      return this.user(existing.id)!;
    }
    const id = newId("u");
    this.db.run("INSERT INTO users (id, github_id, login, name, avatar_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, gh.id, gh.login, gh.name, gh.avatar_url, now(), now());
    return this.user(id)!;
  }

  /** Development sign-in by name (VIREO_DEV_LOGIN): one account per login, no GitHub. */
  upsertDev(login: string): User {
    const existing = this.db.get<UserRow>("SELECT * FROM users WHERE github_id IS NULL AND login = ?", login);
    if (existing) return toUser(existing);
    const id = newId("u");
    this.db.run("INSERT INTO users (id, github_id, login, name, avatar_url, created_at, last_seen_at) VALUES (?, NULL, ?, ?, NULL, ?, ?)", id, login, login, now(), now());
    return this.user(id)!;
  }

  // ---- sign-in handshake ----

  /** Starts a GitHub sign-in that returns to the given app origin. */
  begin(returnTo: string): string {
    this.sweep();
    const state = secret();
    this.db.run("INSERT INTO sign_ins (key, kind, return_to, expires_at) VALUES (?, 'state', ?, ?)", hash(state), returnTo, now() + SIGN_IN_TTL);
    return state;
  }

  /** Checks and consumes the OAuth state; returns where the app is. */
  takeState(state: string): string | undefined {
    const key = hash(state);
    const r = this.db.get<{ return_to: string; expires_at: number }>("SELECT return_to, expires_at FROM sign_ins WHERE key = ? AND kind = 'state'", key);
    this.db.run("DELETE FROM sign_ins WHERE key = ?", key);
    return r && r.expires_at > now() ? r.return_to : undefined;
  }

  /** A one-time code for the app to trade for a session. */
  issueCode(userId: string): string {
    const code = secret();
    this.db.run("INSERT INTO sign_ins (key, kind, user_id, expires_at) VALUES (?, 'code', ?, ?)", hash(code), userId, now() + 60_000);
    return code;
  }

  /** Trades a one-time code for a session token. */
  redeem(code: string): { token: string; user: User } | undefined {
    const key = hash(code);
    const r = this.db.get<{ user_id: string; expires_at: number }>("SELECT user_id, expires_at FROM sign_ins WHERE key = ? AND kind = 'code'", key);
    this.db.run("DELETE FROM sign_ins WHERE key = ?", key);
    if (!r || r.expires_at < now()) return undefined;
    const user = this.user(r.user_id);
    if (!user) return undefined;
    const token = secret();
    this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", hash(token), user.id, now(), now() + SESSION_TTL);
    return { token, user };
  }

  /** The signed-in user for a session token. */
  session(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const r = this.db.get<{ user_id: string; expires_at: number }>("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", hash(token));
    if (!r || r.expires_at < now()) return undefined;
    return this.user(r.user_id);
  }

  signOut(token: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", hash(token));
  }

  private sweep(): void {
    this.db.run("DELETE FROM sign_ins WHERE expires_at < ?", now());
    this.db.run("DELETE FROM sessions WHERE expires_at < ?", now());
  }

  // ---- GitHub ----

  githubAuthorizeUrl(state: string): string {
    const gh = this.config.github!;
    const params = new URLSearchParams({ client_id: gh.clientId, redirect_uri: `${this.config.publicUrl}/auth/github/callback`, state, scope: "read:user", allow_signup: "true" });
    return `${this.config.githubUrls.authorize}?${params}`;
  }

  /** Exchanges GitHub's code for the user it belongs to. */
  async githubUser(code: string): Promise<User> {
    const gh = this.config.github!;
    const res = await fetch(this.config.githubUrls.token, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: `${this.config.publicUrl}/auth/github/callback` }),
    });
    const body = (await res.json()) as { access_token?: string; error_description?: string };
    if (!body.access_token) throw new Error(body.error_description ?? "GitHub did not return a token");
    const me = await fetch(`${this.config.githubUrls.api}/user`, { headers: { authorization: `Bearer ${body.access_token}`, accept: "application/vnd.github+json", "user-agent": "Vireo" } });
    if (!me.ok) throw new Error(`GitHub answered ${me.status}`);
    return this.upsertGithub((await me.json()) as { id: number; login: string; name: string | null; avatar_url: string | null });
  }
}
