import { createCloud, type Cloud } from "../core/cloud.js";
import { parseConfig, type Env } from "../core/config.js";
import { SCHEMA } from "../core/sql.js";
import { D1Sql } from "./d1.js";
import { DurableHub } from "./hub.js";

/** Bindings and settings from wrangler.jsonc (vars) and `wrangler secret put` (GITHUB_CLIENT_SECRET). */
export interface WorkerEnv {
  DB: D1Database;
  RELAY: DurableObjectNamespace;
  VIREO_CLOUD_URL?: string;
}

let cloud: Promise<Cloud> | undefined;

/**
 * The cloud's services, made once per isolate: the tables on first use, the
 * signing key from D1. `origin` stands in for VIREO_CLOUD_URL when unset.
 */
export function cloudFor(env: WorkerEnv, origin: string): Promise<Cloud> {
  cloud ??= (async () => {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    const config = parseConfig(env as unknown as Env, origin);
    return createCloud(config, new D1Sql(env.DB), new DurableHub(env.RELAY));
  })().catch((err) => {
    cloud = undefined;
    throw err;
  });
  return cloud;
}
