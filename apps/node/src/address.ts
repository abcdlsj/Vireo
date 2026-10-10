import type { Config } from "./config.js";
import type { Identity } from "./identity.js";
import type { RequestInfo } from "./plugins/types.js";

/** Where this node can be reached: by browsers, by itself, and directly when a plugin serves it. */
export class Address {
  /** Set while a plugin serves this node at a direct address (e.g. https://box.tailnet.ts.net). */
  directUrl: string | undefined;
  /** Called when the direct address changes, so the cloud can be told. */
  onChange: () => void = () => undefined;

  constructor(
    private readonly config: Config,
    private readonly identity: Identity,
  ) {}

  setDirectUrl(url: string | undefined): void {
    if (url === this.directUrl) return;
    this.directUrl = url;
    this.onChange();
  }

  /** The node's address on the cloud relay, once linked in relay mode. */
  relayUrl(): string | undefined {
    const id = this.identity.get();
    return id?.mode === "relay" ? `${id.cloudUrl}/n/${id.nodeId}` : undefined;
  }

  /** Base URL for OAuth redirects and webhooks: configured, else direct, else the relay, else where the request came from. */
  publicUrl(req?: RequestInfo): string {
    return this.config.publicUrl ?? this.directUrl ?? this.relayUrl() ?? req?.origin ?? this.localUrl();
  }

  localUrl(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }
}
