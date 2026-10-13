import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Runs the node as a background service of the signed-in user, started at
 * login and restarted when it stops: launchd on macOS, a systemd user unit on
 * Linux. The service runs a copy of the node installed under the data
 * directory (not npx's cache, which can be cleared), so `service upgrade`
 * swaps that copy and restarts it.
 */

const PACKAGE = "askvireo";
const LABEL = "com.askvireo.node";
const UNIT = "askvireo.service";

/** Environment the service keeps from the shell it was installed from: where tools are, and Vireo's own settings. */
const KEEP = /^(PATH|HOME|LANG|LC_ALL|VIREO_\w+|OPENAI_\w+|BRAVE_API_KEY|GOOGLE_CLIENT_\w+|HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|CLAUDE_\w+|CODEX_\w+)$/;

export interface ServicePaths {
  dataDir: string;
  /** The node copy the service runs. */
  appDir: string;
  logFile: string;
}

export function servicePaths(dataDir: string): ServicePaths {
  return { dataDir, appDir: join(dataDir, "app"), logFile: join(dataDir, "logs", "node.log") };
}

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);
const uid = () => userInfo().uid;

function run(cmd: string, args: string[], quiet = false): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "inherit"] });
}

function tryRun(cmd: string, args: string[]): boolean {
  try {
    run(cmd, args, true);
    return true;
  } catch {
    return false;
  }
}

function supported(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Running as a service works on macOS and Linux. On Windows, run the node in a terminal or with Docker.");
}

/** Installs the given version of the node under the data directory, with npm. */
function installCopy(p: ServicePaths, version: string): string {
  mkdirSync(p.appDir, { recursive: true });
  const npm = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  console.log(`  Installing ${PACKAGE}@${version} into ${p.appDir} …`);
  execFileSync(existsSync(npm) ? npm : "npm", ["install", "--prefix", p.appDir, "--no-audit", "--no-fund", "--loglevel=error", "--omit=dev", `${PACKAGE}@${version}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return join(p.appDir, "node_modules", ...PACKAGE.split("/"), "dist", "cli.js");
}

function environment(p: ServicePaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && KEEP.test(k)) env[k] = v;
  env.VIREO_DATA_DIR = p.dataDir;
  // Lets the node keep its own copy up to date (watch.ts).
  env.VIREO_SERVICE = "1";
  return env;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function writeLaunchd(p: ServicePaths, cli: string): void {
  const args = [process.execPath, "--disable-warning=ExperimentalWarning", cli, "start", "--yes"];
  const env = environment(p);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(p.dataDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(p.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(p.logFile)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist, { mode: 0o600 });
  tryRun("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath()]);
}

function writeSystemd(p: ServicePaths, cli: string): void {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const env = environment(p);
  const unit = `[Unit]
Description=Vireo node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[process.execPath, "--disable-warning=ExperimentalWarning", cli, "start", "--yes"].map(q).join(" ")}
WorkingDirectory=${p.dataDir}
${Object.entries(env)
  .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
  .join("\n")}
Restart=always
RestartSec=10
StandardOutput=append:${p.logFile}
StandardError=append:${p.logFile}

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(unitPath()), { recursive: true });
  writeFileSync(unitPath(), unit, { mode: 0o600 });
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", UNIT]);
  run("systemctl", ["--user", "restart", UNIT]);
}

export function installed(): boolean {
  return process.platform === "darwin" ? existsSync(plistPath()) : process.platform === "linux" ? existsSync(unitPath()) : false;
}

/** The service's own copy of the node's CLI, once installed. */
export function installedCli(p: ServicePaths): string | undefined {
  const cli = join(p.appDir, "node_modules", ...PACKAGE.split("/"), "dist", "cli.js");
  return existsSync(cli) ? cli : undefined;
}

/** Installs (or reinstalls) the service with this version of the node, and starts it; returns the CLI it runs. */
export function install(p: ServicePaths, version: string): string {
  supported();
  mkdirSync(dirname(p.logFile), { recursive: true });
  const cli = installCopy(p, version);
  if (process.platform === "darwin") writeLaunchd(p, cli);
  else writeSystemd(p, cli);
  return cli;
}

export function restart(): void {
  supported();
  if (process.platform === "darwin") run("launchctl", ["kickstart", "-k", `gui/${uid()}/${LABEL}`]);
  else run("systemctl", ["--user", "restart", UNIT]);
}

export function uninstall(p: ServicePaths): void {
  supported();
  if (process.platform === "darwin") {
    tryRun("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
    rmSync(plistPath(), { force: true });
  } else {
    tryRun("systemctl", ["--user", "disable", "--now", UNIT]);
    rmSync(unitPath(), { force: true });
    tryRun("systemctl", ["--user", "daemon-reload"]);
  }
  rmSync(p.appDir, { recursive: true, force: true });
}

/** Whether the service is loaded and running, in the platform's words. */
export function status(): string {
  supported();
  if (!installed()) return "not installed";
  if (process.platform === "darwin") {
    try {
      const out = run("launchctl", ["print", `gui/${uid()}/${LABEL}`], true);
      const state = /\bstate = (\w+)/.exec(out)?.[1] ?? "unknown";
      const pid = /\bpid = (\d+)/.exec(out)?.[1];
      return pid ? `${state} (pid ${pid})` : state;
    } catch {
      return "installed, not loaded";
    }
  }
  try {
    return run("systemctl", ["--user", "is-active", UNIT], true).trim();
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? "inactive").trim() || "inactive";
  }
}

/** Linux only: without lingering, user services stop when the user logs out (a headless server). */
export function lingerHint(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const out = run("loginctl", ["show-user", userInfo().username, "--property=Linger"], true);
    if (/Linger=yes/.test(out)) return undefined;
  } catch {
    return undefined;
  }
  return `To keep it running after you log out, run: sudo loginctl enable-linger ${userInfo().username}`;
}
