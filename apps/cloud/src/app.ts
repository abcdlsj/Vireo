import { Accounts } from "./accounts.js";
import type { CloudConfig } from "./config.js";
import { Db } from "./db.js";
import type { Cloud } from "./http.js";
import { SigningKey } from "./keys.js";
import { Nodes } from "./nodes.js";
import { Relay } from "./relay.js";

export interface CloudApp extends Cloud {
  db: Db;
}

/** Wires the cloud's services once at start-up. */
export function createCloud(config: CloudConfig): CloudApp {
  const db = new Db(config.dataDir);
  const key = new SigningKey(config.dataDir);
  const accounts = new Accounts(db, config);
  let relay: Relay | undefined;
  const nodes = new Nodes(db, config, accounts, key, (id) => relay?.online(id) ?? false);
  relay = new Relay(nodes);
  return {
    config,
    db,
    key,
    accounts,
    nodes,
    relay,
  };
}
