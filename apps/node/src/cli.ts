#!/usr/bin/env node
import type { NodeMode } from "@vireo/protocol";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { Identity } from "./identity.js";
import { connectAgents } from "./connect.js";
import { linkNode } from "./link.js";
import { brewInstall, brewPath, cannotDownload, findBinaries, systemRunning } from "./plugins/tailscale/binaries.js";
import { runNode } from "./server.js";
import * as service from "./service.js";
import { VERSION } from "./version.js";

const HELP = `Vireo node ${VERSION}: your own Vireo agent, on this machine.

Usage: npx @abcdlsj/vireo-node [command] [options]

Commands:
  start     Start the node (default). Links it to your account first if needed.
  link      Link this node again, e.g. to another account or another way of connecting.
  unlink    Forget the link to the account.
  status    Show which account and cloud this node is linked to.
  connect   Connect Claude Code and Codex on this machine to Vireo: MCP, plus
            hooks that tell you when a long task finishes or it waits on you,
            and ask your approval before a risky shell command.
  service   Run in the background, started at login and restarted if it stops
            (launchd on macOS, systemd on Linux):
              service install     link if needed, then install and start it
              service upgrade     update to the latest version and restart
              service uninstall   stop and remove it (your data stays)
              service status      whether it is running, and where it logs

Options:
  --mode <relay|tailscale>  How the app reaches this node (asked when linking)
  --name <name>             Name shown in the app (default: this machine's name)
  --cloud <url>             Vireo cloud to use
  --data <dir>              Where threads, memory, settings and logs live (default ~/.config/vireo)
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
if (values.help || !["start", "link", "unlink", "status", "service", "connect", "hook"].includes(command)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

/**
 * Everything Vireo keeps on this machine (link, database, files, browser
 * profile, logs, the service's copy of the node) lives in one directory:
 * $XDG_CONFIG_HOME/vireo, usually ~/.config/vireo. Data from before, in
 * ~/.vireo, moves there once.
 */
function defaultDataDir(): string {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vireo");
  const old = join(homedir(), ".vireo");
  const empty = !existsSync(dir) || readdirSync(dir).length === 0;
  if (empty && existsSync(old)) {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      renameSync(old, dir);
      console.error(`  Moved Vireo's data from ${old} to ${dir}.`);
    } catch (err) {
      console.warn(`  Could not move ${old} to ${dir} (${err instanceof Error ? err.message : err}); using ${old}.`);
      return old;
    }
  }
  return dir;
}

process.env.VIREO_DATA_DIR = values.data ?? process.env.VIREO_DATA_DIR ?? defaultDataDir();
if (values.cloud) process.env.VIREO_CLOUD_URL = values.cloud;
if (values.name) process.env.VIREO_NAME = values.name;
if (values.port) process.env.VIREO_PORT = values.port;
const config = loadConfig();
const identity = new Identity(config.dataDir);

if (command === "hook") {
  // Run by a coding agent's hook: quick, quiet, and never in the agent's way.
  const { runHook } = await import("./hook.js");
  await runHook(positionals[1] ?? "", config.dataDir, positionals.slice(2)).catch(() => undefined);
  process.exit(0);
}

/** Connects the coding agents here to this node; the hooks run the service's copy of the node when there is one. */
function connect(cli = service.installedCli(service.servicePaths(config.dataDir)) ?? process.argv[1]!): string[] {
  return connectAgents({ dataDir: config.dataDir, port: config.port, cli });
}

if (command === "connect") {
  try {
    const lines = connect();
    console.log(lines.length ? lines.map((l) => `  ${l}`).join("\n") : "  No Claude Code or Codex found on this machine.");
    if (!service.installedCli(service.servicePaths(config.dataDir))) console.log("  Tip: npx @abcdlsj/vireo-node service install keeps Vireo running for them.");
    process.exit(0);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

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

// Only starting or installing the node may need to link it, and so to ask.
const linking = command !== "service" || positionals[1] === "install";
const mode = identity.get()?.mode ?? (linking ? await chooseMode() : config.mode);

function showLinkCode(start: { verifyUrl: string; userCode: string }): void {
  console.log(`
  Link this node to your Vireo account:

      ${start.verifyUrl}

  Sign in with GitHub there and check the code shows ${start.userCode}.
`);
  if (interactive) openBrowser(start.verifyUrl);
}

if (command === "service") {
  const action = positionals[1] ?? "status";
  const paths = service.servicePaths(config.dataDir);
  try {
    if (action === "status") {
      console.log(`  Service: ${service.status()}\n  Data: ${config.dataDir}\n  Log: ${paths.logFile}`);
    } else if (action === "install" || action === "upgrade") {
      if (action === "upgrade" && !service.installed()) throw new Error("The service is not installed yet. Run: npx @abcdlsj/vireo-node service install");
      // A node running in a terminal holds the port; the service would fail to start next to it.
      const running = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.ok,
        () => false,
      );
      if (running && !service.installed()) throw new Error(`A Vireo node is already running on port ${config.port}. Stop it (Ctrl+C in its terminal), then run this again.`);
      if (!identity.get()) {
        console.log("  First, link this node to your account.");
        identity.save(await linkNode({ cloudUrl: config.cloudUrl, request: { name: config.name, platform: platform(), version: VERSION, mode }, onCode: showLinkCode }));
        console.log("  Linked.");
      }
      const cli = service.install(paths, action === "upgrade" ? "latest" : VERSION);
      // The coding agents here talk to the node the service runs; their hooks point at its copy.
      let agents: string[] = [];
      try {
        agents = connect(cli);
      } catch (err) {
        agents = [`Could not connect the coding agents here: ${err instanceof Error ? err.message : err}`];
      }
      console.log(`
  Vireo runs in the background now, and starts again at login.
  Data: ${config.dataDir}
  Log:  ${paths.logFile}
  Update later with: npx @abcdlsj/vireo-node service upgrade`);
      for (const line of agents) console.log(`  ${line}`);
      const hint = service.lingerHint();
      if (hint) console.log(`  ${hint}`);
    } else if (action === "uninstall") {
      service.uninstall(paths);
      console.log(`  Stopped and removed the service. Your data stays in ${config.dataDir}.`);
    } else {
      console.log(HELP);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
config.mode = mode;
const tailscale = mode === "tailscale" ? await chooseTailscale() : undefined;

/**
 * On a machine that already runs Tailscale (Tailscale.app on a Mac
 * included), use it; otherwise Vireo runs its own tailscaled, which the
 * Tailscale plugin downloads on Linux. A Mac with neither can get it from
 * Homebrew.
 */
async function chooseTailscale(): Promise<{ mode: "system" | "managed" }> {
  const found = findBinaries("");
  if (found && (await systemRunning(found.cli))) return { mode: "system" };
  if (found?.daemon || !cannotDownload()) return { mode: "managed" };
  const brew = brewPath();
  if (brew && interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("  Tailscale isn't on this Mac. Install it with Homebrew (brew install tailscale)? [Y/n]: ")).trim().toLowerCase();
    rl.close();
    if (answer === "" || answer.startsWith("y")) {
      console.log("  Installing Tailscale with Homebrew…");
      try {
        await brewInstall();
        return { mode: "managed" };
      } catch (err) {
        console.error(`  ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  console.error(
    platform() === "darwin"
      ? `  Tailscale isn't on this Mac. Install Tailscale from https://tailscale.com/download/mac${brew ? " (or run: brew install tailscale)" : ""} and start this again, or choose the cloud relay (npx @abcdlsj/vireo-node link).`
      : `  Tailscale isn't on this machine and Vireo can't download it: ${cannotDownload()} Install it (https://tailscale.com/download) or choose the cloud relay (npx @abcdlsj/vireo-node link).`,
  );
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
  onLinkCode: showLinkCode,
});

const shutdown = () => void node.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
