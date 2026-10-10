import { Accounts } from "./accounts.js";
import type { CloudConfig } from "./config.js";
import type { NodeHub } from "./hub.js";
import { SigningKey } from "./keys.js";
import { Nodes } from "./nodes.js";
import { SCHEMA, type Sql } from "./sql.js";

export interface Cloud {
  config: CloudConfig;
  sql: Sql;
  accounts: Accounts;
  nodes: Nodes;
  key: SigningKey;
  hub: NodeHub;
}

/** Makes sure the tables exist; cheap when they already do. */
export async function migrate(sql: Sql): Promise<void> {
  for (const statement of SCHEMA) await sql.run(statement);
}

/** Wires the cloud's services over a database and a hub. */
export async function createCloud(config: CloudConfig, sql: Sql, hub: NodeHub): Promise<Cloud> {
  const key = await SigningKey.load(sql);
  const accounts = new Accounts(sql, config);
  const nodes = new Nodes(sql, config, accounts, key, (id) => hub.online(id));
  return { config, sql, accounts, nodes, key, hub };
}
