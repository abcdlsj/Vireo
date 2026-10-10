import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";

/**
 * Talks to tailscaled through the tailscale CLI. In "managed" mode Vireo runs
 * its own tailscaled with userspace networking and a private state
 * directory, so it joins the tailnet as its own machine without root, a TUN
 * device or anything installed on the host besides the two binaries — the
 * same shape as Memoh's per-bot sidecar, but as a child process so it works
 * on a bare VPS and inside the Docker image alike. In "system" mode it uses
 * the tailscaled already running on the machine.
 */

export interface DaemonOptions {
  mode: "managed" | "system";
  dir: string;
  binDir: string;
  authKey: string;
  hostname: string;
  controlUrl: string;
}

export interface TsPeer {
  ID: string;
  HostName: string;
  DNSName: string;
  OS: string;
  TailscaleIPs?: string[];
  Online: boolean;
  LastSeen?: string;
  Tags?: string[];
  ExitNode?: boolean;
  ExitNodeOption?: boolean;
  Active?: boolean;
  Relay?: string;
  CurAddr?: string;
  KeyExpiry?: string;
  sshHostKeys?: string[];
}

export interface TsStatus {
  BackendState: string;
  AuthURL?: string;
  Self?: TsPeer;
  Peer?: Record<string, TsPeer>;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name: string; MagicDNSSuffix?: string };
  Health?: string[];
}

export class TailscaleDaemon {
  private daemon?: ChildProcess;
  private login?: ChildProcess;
  private serving?: ChildProcess;
  private lastError = "";

  constructor(private readonly opts: () => DaemonOptions) {}

  private bin(name: "tailscale" | "tailscaled"): string {
    const dir = this.opts().binDir;
    return dir ? join(dir, name) : name;
  }

  get socket(): string | undefined {
    const o = this.opts();
    return o.mode === "managed" ? join(o.dir, "tailscaled.sock") : undefined;
  }

  /** Arguments that point the CLI at the right tailscaled. */
  cliPrefix(): string[] {
    const s = this.socket;
    return s ? [`--socket=${s}`] : [];
  }

  cliPath(): string {
    return this.bin("tailscale");
  }

  error(): string {
    return this.lastError;
  }

  cli(args: string[], timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin("tailscale"), [...this.cliPrefix(), ...args], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
          reject(new Error(missing ? `tailscale CLI not found (${this.bin("tailscale")}). Install Tailscale or set the binaries directory.` : (stderr || stdout || err.message).trim()));
        } else resolve(stdout);
      });
    });
  }

  async status(): Promise<TsStatus> {
    return JSON.parse(await this.cli(["status", "--json"])) as TsStatus;
  }

  async start(): Promise<void> {
    const o = this.opts();
    this.lastError = "";
    if (o.mode === "managed") await this.startDaemon();
    await this.ensureUp();
  }

  private async startDaemon(): Promise<void> {
    if (this.daemon && this.daemon.exitCode === null) return;
    const o = this.opts();
    const state = join(o.dir, "state");
    mkdirSync(state, { recursive: true });
    const child = spawn(
      this.bin("tailscaled"),
      [`--statedir=${state}`, `--socket=${this.socket}`, "--tun=userspace-networking", "--port=0"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    child.on("error", (err) => {
      if (this.daemon === child) this.daemon = undefined;
      this.lastError = (err as NodeJS.ErrnoException).code === "ENOENT" ? `tailscaled not found (${this.bin("tailscaled")}). Install Tailscale, set the binaries directory, or switch Connection to the Tailscale already running on this machine.` : err.message;
    });
    child.on("exit", (code) => {
      if (this.daemon === child) {
        this.daemon = undefined;
        if (code) this.lastError = `tailscaled exited (${code}): ${tail.trim().split("\n").at(-1) ?? ""}`;
      }
    });
    this.daemon = child;
    for (let i = 0; i < 50 && !existsSync(this.socket!); i++) {
      if (this.daemon !== child) throw new Error(this.lastError || "tailscaled did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!existsSync(this.socket!)) throw new Error("tailscaled did not open its socket");
  }

  /** Brings the node up; without an auth key the status carries a login URL. */
  private async ensureUp(): Promise<void> {
    const o = this.opts();
    const st = await this.status();
    if (st.BackendState === "Running") {
      if (o.mode === "managed" && o.hostname && st.Self?.HostName !== o.hostname) await this.cli(["set", `--hostname=${o.hostname}`]).catch(() => undefined);
      return;
    }
    if (o.mode === "system") return;
    const args = ["up", `--hostname=${o.hostname || "vireo"}`, "--accept-dns=false"];
    if (o.controlUrl) args.push(`--login-server=${o.controlUrl}`);
    if (o.authKey) {
      // From a file, so the key never shows up in the process list.
      const keyFile = join(o.dir, "authkey");
      writeFileSync(keyFile, o.authKey, { mode: 0o600 });
      try {
        await this.cli([...args, `--auth-key=file:${keyFile}`, "--timeout=60s"], 70_000);
      } finally {
        rmSync(keyFile, { force: true });
      }
      return;
    }
    // Interactive login: `up` waits until the owner opens the URL; status shows it meanwhile.
    this.login?.kill();
    this.login = spawn(this.bin("tailscale"), [...this.cliPrefix(), ...args], { stdio: "ignore" });
    this.login.on("error", () => undefined);
    for (let i = 0; i < 25; i++) {
      const s = await this.status().catch(() => undefined);
      if (s?.AuthURL || s?.BackendState === "Running") return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Serves a local HTTP address at https://<this machine>.<tailnet>.ts.net,
   * reachable only from the tailnet. Works in userspace mode too. When the
   * tailnet has not allowed HTTPS certificates yet, the CLI prints a link to
   * allow them and waits; that link comes back and the CLI keeps waiting in
   * the background, finishing on its own once the owner allows it.
   */
  /** A `tailscale serve` is waiting for the owner to allow HTTPS. */
  get serveWaiting(): boolean {
    return Boolean(this.serving && this.serving.exitCode === null);
  }

  serve(target: string): Promise<{ done: true } | { enableUrl: string }> {
    this.serving?.kill();
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin("tailscale"), [...this.cliPrefix(), "serve", "--bg", target], { stdio: ["ignore", "pipe", "pipe"] });
      this.serving = child;
      let out = "";
      const timer = setTimeout(() => reject(new Error(`tailscale serve did not finish: ${out.trim().slice(-300)}`)), 60_000);
      const seen = (d: Buffer) => {
        out += d.toString();
        const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(out)?.[0];
        if (url) {
          clearTimeout(timer);
          resolve({ enableUrl: url });
        }
      };
      child.stdout!.on("data", seen);
      child.stderr!.on("data", seen);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.serving === child) this.serving = undefined;
        if (code === 0) resolve({ done: true });
        else reject(new Error(out.trim().split("\n").at(-1) || `tailscale serve exited with ${code}`));
      });
    });
  }

  async logout(): Promise<void> {
    await this.cli(["logout"]);
  }

  async stop(): Promise<void> {
    this.login?.kill();
    this.login = undefined;
    this.serving?.kill();
    this.serving = undefined;
    const d = this.daemon;
    this.daemon = undefined;
    if (d && d.exitCode === null) {
      d.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(r, 3000);
        d.once("exit", () => {
          clearTimeout(t);
          r(undefined);
        });
      });
    }
  }

  /** A TCP stream to host:port over the tailnet (works in userspace mode too). */
  connect(host: string, port: number): Duplex {
    const child = spawn(this.bin("tailscale"), [...this.cliPrefix(), "nc", host, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    let err = "";
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => {
      if (code) stream.destroy(new Error(err.trim() || `tailscale nc exited with ${code}`));
    });
    child.on("error", (e) => stream.destroy(e));
    stream.on("close", () => child.kill());
    return stream;
  }
}
