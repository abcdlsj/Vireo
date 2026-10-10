#!/usr/bin/env node
import type { NodeMode } from "@vireo/protocol";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { Identity } from "./identity.js";
import { runNode } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `Vireo node ${VERSION}: your own Vireo agent, on this machine.

Usage: npx vireo-node [command] [options]

Commands:
  start     Start the node (default). Links it to your account first if needed.
  link      Link this node again, e.g. to another account or another way of connecting.
  unlink    Forget the link to the account.
  status    Show which account and cloud this node is linked to.

Options:
  --mode <relay|tailscale>  How the app reaches this node (asked when linking)
  --name <name>             Name shown in the app (default: this machine's name)
  --cloud <url>             Vireo cloud to use
  --data <dir>              Where threads, memory and settings live (default ~/.vireo)
  --port <port>             Local port (default 8787)
  --yes                     Ask nothing; use the defaults and options given
  --help                    Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string" },
    name: { type: "string" },
    cloud: { type: "string" },
    data: { type: "string" },
    port: { type: "string" },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "start";
if (values.help || !["start", "link", "unlink", "status"].includes(command)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

process.env.VIREO_DATA_DIR = values.data ?? process.env.VIREO_DATA_DIR ?? join(homedir(), ".vireo");
if (values.cloud) process.env.VIREO_CLOUD_URL = values.cloud;
if (values.name) process.env.VIREO_NAME = values.name;
if (values.port) process.env.VIREO_PORT = values.port;
const config = loadConfig();
const identity = new Identity(config.dataDir);

if (command === "status") {
  const id = identity.get();
  console.log(id ? `Linked to ${id.owner.login} on ${id.cloudUrl} as node ${id.nodeId} (${id.mode}). Data: ${config.dataDir}` : `Not linked. Data: ${config.dataDir}`);
  process.exit(0);
}
if (command === "unlink" || command === "link") {
  identity.clear();
  if (command === "unlink") {
    console.log("Unlinked. Remove the node in the app too, under Settings → Nodes.");
    process.exit(0);
  }
}

const interactive = process.stdin.isTTY && !values.yes;
const has = (bin: string) => {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Asks how the app should reach this node, the first time only. */
async function chooseMode(): Promise<NodeMode> {
  if (values.mode === "relay" || values.mode === "tailscale") return values.mode;
  if (!interactive) return config.mode;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
  How should the Vireo app reach this node?

    1. Through the Vireo cloud (recommended): works from anywhere, nothing to open or install.
    2. Over Tailscale: your devices talk to this node directly on your tailnet;
       the cloud only signs you in. Needs Tailscale on this machine and your devices.
`);
  const answer = (await rl.question("  Choose 1 or 2 [1]: ")).trim();
  rl.close();
  return answer === "2" ? "tailscale" : "relay";
}

const mode = identity.get()?.mode ?? (await chooseMode());
config.mode = mode;
// On a machine that already runs Tailscale, use it; otherwise Vireo runs its own tailscaled.
const tailscale = mode === "tailscale" ? { mode: has("tailscale") ? "system" : "managed" } : undefined;
if (tailscale?.mode === "managed" && !has("tailscaled")) {
  console.error("  Tailscale is not installed here. Install it (https://tailscale.com/download) or choose the cloud relay.");
  process.exit(1);
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
}

console.log("");
const node = await runNode(config, {
  tailscale,
  onLinkCode: (start) => {
    console.log(`
  Link this node to your Vireo account:

      ${start.verifyUrl}

  Sign in with GitHub there and check the code shows ${start.userCode}.
`);
    if (interactive) openBrowser(start.verifyUrl);
  },
});

const shutdown = () => void node.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
