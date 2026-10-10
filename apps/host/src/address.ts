import type { Config } from "./config.js";
import type { RequestInfo } from "./plugins/types.js";

/** Where this node can be reached: by browsers, by itself, and directly when a plugin serves it. */
export class Address {
  /** Set while a plugin serves this node at a direct address (e.g. https://box.tailnet.ts.net). */
  directUrl: string | undefined;

  constructor(private readonly config: Config) {}

  /** Base URL for OAuth redirects and webhooks: configured, else direct, else where the request came from. */
  publicUrl(req?: RequestInfo): string {
    return this.config.publicUrl ?? this.directUrl ?? req?.origin ?? this.localUrl();
  }

  localUrl(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }
}
