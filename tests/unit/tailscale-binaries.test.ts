import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheDir, cannotDownload, downloadBinaries, findBinaries, TAILSCALE_VERSION } from "../../apps/node/src/plugins/tailscale/binaries.js";
import { tempDir } from "./helpers.js";

const ARCH = ({ x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386", riscv64: "riscv64" } as Record<string, string>)[arch()];
const linux = platform() === "linux" && Boolean(ARCH);

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.VIREO_TAILSCALE_MIRROR;
  delete process.env.VIREO_TAILSCALE_DOWNLOAD;
});

/** A stand-in for pkgs.tailscale.com serving one release, with the checksum it publishes. */
async function mirror(opts: { badSum?: boolean } = {}): Promise<{ url: string; hits: string[] }> {
  const name = `tailscale_${TAILSCALE_VERSION}_${ARCH}`;
  const src = tempDir();
  mkdirSync(join(src, name, "systemd"), { recursive: true });
  for (const bin of ["tailscale", "tailscaled"]) {
    writeFileSync(join(src, name, bin), `#!/bin/sh\necho ${bin}\n`);
    chmodSync(join(src, name, bin), 0o755);
  }
  writeFileSync(join(src, name, "systemd", "tailscaled.service"), "");
  execFileSync("tar", ["-czf", join(src, "release.tgz"), "-C", src, name]);
  const tgz = readFileSync(join(src, "release.tgz"));
  const sum = opts.badSum ? "0".repeat(64) : createHash("sha256").update(tgz).digest("hex");
  const hits: string[] = [];
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === `/stable/${name}.tgz`) res.writeHead(200, { "content-length": tgz.length }).end(tgz);
    else if (req.url === `/stable/${name}.tgz.sha256`) res.end(`${sum}\n`);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/stable`, hits };
}

describe("tailscale binaries", () => {
  it("uses the directory the owner set, as is", () => {
    const dir = tempDir();
    expect(findBinaries(dir)).toEqual({ cli: join(dir, "tailscale"), daemon: undefined });
    writeFileSync(join(dir, "tailscaled"), "");
    expect(findBinaries(dir)?.daemon).toBe(join(dir, "tailscaled"));
  });

  it("finds a downloaded copy under Vireo's own directory", () => {
    const dir = tempDir();
    const PATH = process.env.PATH;
    process.env.PATH = "";
    try {
      const before = findBinaries("", dir);
      expect(before?.cli ?? "").not.toContain(dir);
      mkdirSync(cacheDir(dir), { recursive: true });
      for (const bin of ["tailscale", "tailscaled"]) {
        writeFileSync(join(cacheDir(dir), bin), "#!/bin/sh\n");
        chmodSync(join(cacheDir(dir), bin), 0o755);
      }
      // Tailscale installed on the machine still wins; otherwise Vireo's copy.
      const after = findBinaries("", dir)!;
      if (!before?.daemon) expect(after).toEqual({ cli: join(cacheDir(dir), "tailscale"), daemon: join(cacheDir(dir), "tailscaled") });
    } finally {
      process.env.PATH = PATH;
    }
  });

  it("can be told not to download", () => {
    process.env.VIREO_TAILSCALE_DOWNLOAD = "off";
    expect(cannotDownload()).toContain("turned off");
  });

  it.runIf(linux)("downloads, checks and unpacks only the two binaries", async () => {
    const m = await mirror();
    process.env.VIREO_TAILSCALE_MIRROR = m.url;
    const dir = tempDir();
    const seen: number[] = [];
    const got = await downloadBinaries(dir, (p) => seen.push(p.received));
    expect(got).toEqual({ cli: join(cacheDir(dir), "tailscale"), daemon: join(cacheDir(dir), "tailscaled") });
    expect(execFileSync(got.daemon!).toString().trim()).toBe("tailscaled");
    expect(readdirSync(cacheDir(dir)).sort()).toEqual(["tailscale", "tailscaled"]);
    expect(seen.length).toBeGreaterThan(0);
    // Nothing half-done is left next to it.
    expect(readdirSync(join(dir, "bin"))).toEqual([`tailscale-${TAILSCALE_VERSION}`]);
  });

  it.runIf(linux)("installs nothing when the download doesn't match its checksum", async () => {
    const m = await mirror({ badSum: true });
    process.env.VIREO_TAILSCALE_MIRROR = m.url;
    const dir = tempDir();
    await expect(downloadBinaries(dir)).rejects.toThrow(/didn't match its checksum/);
    expect(existsSync(cacheDir(dir))).toBe(false);
    expect(readdirSync(join(dir, "bin"))).toEqual([]);
  });
});
