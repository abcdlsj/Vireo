import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Finding the tailscale and tailscaled binaries, and fetching them when the
 * machine has none. Tailscale already on the machine comes first, so Vireo
 * does not become a second node next to it. On Linux the official static
 * build is downloaded into Vireo's own directory (no root, nothing installed
 * system-wide); macOS has no such build, so there it is Tailscale.app's CLI
 * or Homebrew's open-source build.
 */

/** The version Vireo downloads; the Docker image ships the same one. */
export const TAILSCALE_VERSION = "1.102.5";
/** Tailscale.app keeps its CLI inside the bundle, off PATH unless the owner added it. */
export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface Binaries {
  cli: string;
  /** Missing when only a CLI was found (Tailscale.app, or a system install whose daemon we can't run). */
  daemon?: string;
}

/** Places packages and Homebrew put Tailscale, often missing from a service's PATH. */
const KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/usr/sbin", "/usr/local/sbin", "/snap/bin"];

const runnable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where downloaded binaries live, by version, under `dir`. */
export const cacheDir = (dir: string) => join(dir, "bin", `tailscale-${TAILSCALE_VERSION}`);

/**
 * Tailscale's binaries: from `binDir` when the owner set one, else a
 * directory with both (PATH, the usual places, Vireo's own download), else
 * any CLI on its own (Tailscale.app on a Mac).
 */
export function findBinaries(binDir: string, dir?: string): Binaries | undefined {
  if (binDir) {
    const daemon = join(binDir, "tailscaled");
    return { cli: join(binDir, "tailscale"), daemon: existsSync(daemon) ? daemon : undefined };
  }
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...KNOWN_DIRS, ...(dir ? [cacheDir(dir)] : [])];
  const unique = [...new Set(dirs)];
  for (const d of unique) {
    if (runnable(join(d, "tailscale")) && runnable(join(d, "tailscaled"))) return { cli: join(d, "tailscale"), daemon: join(d, "tailscaled") };
  }
  for (const d of unique) if (runnable(join(d, "tailscale"))) return { cli: join(d, "tailscale") };
  if (platform() === "darwin" && runnable(MAC_APP_CLI)) return { cli: MAC_APP_CLI };
  return undefined;
}

/** Tailscale's name for this machine's architecture, when it publishes a Linux build for it. */
function linuxArch(): string | undefined {
  return ({ x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386", riscv64: "riscv64" } as Record<string, string>)[arch()];
}

/** Why Vireo can't download Tailscale here, or undefined when it can. */
export function cannotDownload(): string | undefined {
  if (process.env.VIREO_TAILSCALE_DOWNLOAD === "off") return "Downloading Tailscale is turned off (VIREO_TAILSCALE_DOWNLOAD=off).";
  if (platform() !== "linux") return `Tailscale publishes no standalone build for ${platform()}.`;
  if (!linuxArch()) return `Tailscale publishes no Linux build for ${arch()}.`;
  return undefined;
}

export interface Progress {
  received: number;
  total: number;
}

/**
 * Downloads the static Linux build into `dir`, checks it against the
 * published SHA-256 and unpacks only the two binaries. A half-finished
 * download never lands where findBinaries looks.
 */
export async function downloadBinaries(dir: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Binaries> {
  const why = cannotDownload();
  if (why) throw new Error(why);
  const name = `tailscale_${TAILSCALE_VERSION}_${linuxArch()}`;
  const base = (process.env.VIREO_TAILSCALE_MIRROR || "https://pkgs.tailscale.com/stable").replace(/\/$/, "");
  const url = `${base}/${name}.tgz`;
  const target = cacheDir(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const work = mkdtempSync(join(dir, "bin", ".download-"));
  try {
    const sumRes = await fetch(`${url}.sha256`, { signal });
    if (!sumRes.ok) throw new Error(`Couldn't get the checksum for Tailscale ${TAILSCALE_VERSION} from ${base} (HTTP ${sumRes.status}).`);
    const want = /[0-9a-f]{64}/i.exec(await sumRes.text())?.[0]?.toLowerCase();
    if (!want) throw new Error(`The checksum file at ${url}.sha256 is not a SHA-256.`);

    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download Tailscale from ${url} (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const sha = createHash("sha256");
    let received = 0;
    const tgz = join(work, `${name}.tgz`);
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    await pipeline(
      body,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          sha.update(chunk);
          received += chunk.length;
          onProgress?.({ received, total });
          yield chunk;
        }
      },
      createWriteStream(tgz),
      { signal },
    );
    const got = sha.digest("hex");
    if (got !== want) throw new Error(`The Tailscale download from ${url} didn't match its checksum; nothing was installed.`);

    await new Promise<void>((ok, fail) =>
      execFile("tar", ["-xzf", tgz, "-C", work, `${name}/tailscale`, `${name}/tailscaled`], (err, _out, stderr) => (err ? fail(new Error(`Couldn't unpack Tailscale: ${stderr || err.message}`)) : ok())),
    );
    rmSync(target, { recursive: true, force: true });
    renameSync(join(work, name), target);
    return { cli: join(target, "tailscale"), daemon: join(target, "tailscaled") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Homebrew, when it is on this Mac. */
export function brewPath(): string | undefined {
  if (platform() !== "darwin") return undefined;
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(runnable);
}

/** `brew install tailscale`: the open-source CLI and daemon, which Vireo runs itself without root. */
export function brewInstall(): Promise<void> {
  const brew = brewPath();
  if (!brew) return Promise.reject(new Error("Homebrew is not installed on this Mac."));
  return new Promise((ok, fail) =>
    execFile(brew, ["install", "tailscale"], { timeout: 10 * 60_000, maxBuffer: 8 << 20, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } }, (err, _out, stderr) =>
      err ? fail(new Error(`brew install tailscale failed: ${(stderr || err.message).trim().split("\n").at(-1)}`)) : ok(),
    ),
  );
}

/** Whether a tailscaled already runs on this machine and answers its CLI. */
export function systemRunning(cli: string): Promise<boolean> {
  return new Promise((ok) => execFile(cli, ["status", "--json"], { timeout: 5000 }, (err, stdout) => ok(!err || /"BackendState"/.test(String(stdout)))));
}
