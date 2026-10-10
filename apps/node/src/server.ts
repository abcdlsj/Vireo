import { serve } from "@hono/node-server";
import type { LinkStart } from "@vireo/protocol";
import type { Server } from "node:http";
import { platform } from "node:os";
import { createApp, type App } from "./app.js";
import type { Config } from "./config.js";
import { createHttp } from "./http/index.js";
import { linkNode } from "./link.js";
import { RelayClient } from "./relay-client.js";
import { errorMessage } from "./util.js";
import { VERSION } from "./version.js";

export interface RunOptions {
  /** Shows the owner where to approve this node (the CLI also opens the browser). */
  onLinkCode?: (start: LinkStart) => void;
  /** Settings for the Tailscale plugin when this node is reached over the tailnet. */
  tailscale?: Record<string, unknown>;
}

export interface RunningNode {
  app: App;
  server: Server;
  stop(): Promise<void>;
}

const say = (line: string) => console.log(`  ${line}`);

/**
 * Starts a node: the agent, its HTTP API on the loopback interface, and its
 * link to the cloud. A node that is not linked yet asks the cloud for a code
 * and waits for its owner to approve it in the app; once linked it opens the
 * relay socket (or, in tailscale mode, serves itself on the tailnet).
 */
export async function runNode(config: Config, opts: RunOptions = {}): Promise<RunningNode> {
  const app = createApp(config);
  const http = createHttp(app);
  let relay: RelayClient | undefined;
  const linking = new AbortController();

  await app.models.refresh();
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: http.fetch, port: config.port, hostname: config.host }, () => resolve(s as Server)) as Server;
  });
  const status = app.models.status();
  say(`Vireo node ${VERSION} on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
  say(`Data: ${config.dataDir}`);
  say(
    status.ready
      ? `Model: ${status.main} at ${status.baseUrl} (routine work: ${status.fast})`
      : `Model: none yet. Set one in the app under Settings → Model, or set OPENAI_API_KEY.${status.error ? ` (${status.error})` : ""}`,
  );

  const connect = () => {
    const identity = app.identity.get()!;
    say(`Linked to ${identity.owner.login} on ${identity.cloudUrl} (${identity.mode === "tailscale" ? "over Tailscale" : "through the cloud relay"})`);
    relay = new RelayClient({
      identity,
      version: VERSION,
      platform: platform(),
      directUrl: () => app.address.directUrl,
      handle: (req) => Promise.resolve(http.fetch(req)),
      onRevoked: () => {
        app.identity.clear();
        say("This node was removed from its account. Run `npx vireo-node` again to link it.");
      },
    });
    app.address.onChange = () => relay?.update();
    relay.start();
  };

  void app.plugins.start().then(async () => {
    const mode = app.identity.get()?.mode ?? config.mode;
    if (mode === "tailscale" && !app.plugins.installed("tailscale")) {
      say("Tailscale: putting this node on your tailnet…");
      await app.plugins.install("tailscale", { serve: true, ...opts.tailscale }).catch((err: Error) => say(`Tailscale: ${err.message}`));
    }
  });
  app.runner.resumeInterrupted();
  app.scheduler.start();

  if (app.identity.get()) connect();
  else {
    void linkNode({
      cloudUrl: config.cloudUrl,
      request: { name: config.name, platform: platform(), version: VERSION, mode: config.mode },
      onCode:
        opts.onLinkCode ??
        ((start) => {
          say("");
          say(`Link this node to your Vireo account: open ${start.verifyUrl}`);
          say(`and check the code is ${start.userCode}. (It expires in 15 minutes; a new one follows.)`);
          say("");
        }),
      signal: linking.signal,
    })
      .then((identity) => {
        app.identity.save(identity);
        connect();
      })
      .catch((err) => {
        if (!linking.signal.aborted) say(`Linking failed: ${errorMessage(err)}`);
      });
  }

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      linking.abort();
      relay?.stop();
      app.scheduler.stop();
      server.close();
      await Promise.race([app.runner.idle(), new Promise((r) => setTimeout(r, 5000))]);
      await app.browser.shutdown();
      await app.plugins.stop();
      app.db.close();
    })());
  return { app, server, stop };
}
