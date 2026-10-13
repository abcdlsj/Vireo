import type { CloudConfig } from "./config.js";
import type { Sql } from "./sql.js";
import { now } from "./util.js";

const SIGN_IN_TTL = 30 * 60_000;

/** What Google answers a token request with, passed to the node as is. */
export interface GoogleAnswer {
  status: number;
  body: unknown;
}

/**
 * Vireo's shared Google OAuth client, for nodes whose owner did not create
 * their own. Google redirects to the cloud's one registered address; the
 * cloud sends the browser on to the node that started the sign-in, and makes
 * the token requests that need the client secret. Tokens go back to the node
 * and are not kept here.
 */
export class GoogleBroker {
  constructor(
    private readonly sql: Sql,
    private readonly config: CloudConfig,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.google);
  }

  get redirectUri(): string {
    return `${this.config.publicUrl}/oauth/google/callback`;
  }

  info(): { clientId: string; redirectUri: string } | undefined {
    return this.config.google && { clientId: this.config.google.clientId, redirectUri: this.redirectUri };
  }

  /** A node starts a sign-in: Google's answer for this state goes to its callback. */
  async begin(nodeId: string, state: string, callback: string): Promise<void> {
    await this.sql.run("DELETE FROM google_sign_ins WHERE expires_at < ?", now());
    await this.sql.run(
      "INSERT OR REPLACE INTO google_sign_ins (state, node_id, callback, expires_at) VALUES (?, ?, ?, ?)",
      state,
      nodeId,
      callback,
      now() + SIGN_IN_TTL,
    );
  }

  /** Where to send the browser Google returned with this state. */
  async callback(state: string): Promise<string | undefined> {
    const r = await this.sql.first<{ callback: string }>("SELECT callback FROM google_sign_ins WHERE state = ? AND expires_at > ?", state, now());
    return r?.callback;
  }

  /** The node that started the sign-in trades its code for tokens, once. */
  async exchange(nodeId: string, state: string, code: string): Promise<GoogleAnswer | undefined> {
    if ((await this.sql.run("DELETE FROM google_sign_ins WHERE state = ? AND node_id = ? AND expires_at > ?", state, nodeId, now())) === 0) return undefined;
    return this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
  }

  async refresh(refreshToken: string): Promise<GoogleAnswer> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async token(params: Record<string, string>): Promise<GoogleAnswer> {
    const client = this.config.google!;
    const res = await fetch(this.config.googleTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    return { status: res.status, body: await res.json().catch(() => ({ error: "bad_response" })) };
  }
}
