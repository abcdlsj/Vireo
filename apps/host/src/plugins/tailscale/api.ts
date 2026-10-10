/**
 * The Tailscale admin API (api.tailscale.com), for managing the tailnet's
 * machines: authorising, removing, tagging, routes and key expiry. Needs an
 * API access token from the admin console; the daemon alone cannot do this.
 */

export interface ApiDevice {
  id: string;
  nodeId?: string;
  name: string;
  hostname: string;
  addresses: string[];
  os: string;
  user?: string;
  authorized: boolean;
  keyExpiryDisabled?: boolean;
  expires?: string;
  lastSeen?: string;
  updateAvailable?: boolean;
  clientVersion?: string;
  tags?: string[];
  advertisedRoutes?: string[];
  enabledRoutes?: string[];
  connectedToControl?: boolean;
}

export class TailscaleApi {
  constructor(
    private readonly key: string,
    private readonly tailnet = "-",
    private readonly base = "https://api.tailscale.com/api/v2",
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Tailscale API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async devices(): Promise<ApiDevice[]> {
    return (await this.call<{ devices: ApiDevice[] }>("GET", `/tailnet/${encodeURIComponent(this.tailnet)}/devices?fields=all`)).devices;
  }

  authorize(id: string, authorized: boolean): Promise<void> {
    return this.call("POST", `/device/${id}/authorized`, { authorized });
  }

  remove(id: string): Promise<void> {
    return this.call("DELETE", `/device/${id}`);
  }

  setTags(id: string, tags: string[]): Promise<void> {
    return this.call("POST", `/device/${id}/tags`, { tags });
  }

  setRoutes(id: string, routes: string[]): Promise<void> {
    return this.call("POST", `/device/${id}/routes`, { routes });
  }

  setKeyExpiry(id: string, disabled: boolean): Promise<void> {
    return this.call("POST", `/device/${id}/key`, { keyExpiryDisabled: disabled });
  }

  rename(id: string, name: string): Promise<void> {
    return this.call("POST", `/device/${id}/name`, { name });
  }

  expire(id: string): Promise<void> {
    return this.call("POST", `/device/${id}/expire`);
  }
}
