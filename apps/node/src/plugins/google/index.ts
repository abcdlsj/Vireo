import { Type } from "typebox";
import { defineTool, type ToolContext } from "../../tools/types.js";
import { newId, now, truncate } from "../../util.js";
import type { PluginDef, PluginStatus, RequestInfo } from "../types.js";
import { DRIVE_SCOPE, GoogleAuth, GoogleCalendar, GoogleDrive, GoogleMail } from "./api.js";

/**
 * Google Calendar, Gmail and Drive. Calendar and email tools are built in and
 * switch to Google once this plugin is connected; Drive tools come with it.
 */

interface GoogleConfig {
  client_id: string;
  client_secret: string;
}

const CALLBACK = "/public/google/callback";
const CONSOLE = "https://console.cloud.google.com";

/** A sign-in Vireo started and waits for Google to redirect back from. */
interface Pending {
  state: string;
  redirectUri: string;
  /** The Vireo app to return to; none when the agent opened it in Vireo's browser. */
  returnTo?: string;
  /** Started on Vireo's shared client: the cloud trades the code. */
  shared?: boolean;
  at: number;
}
const PENDING_TTL = 30 * 60_000;

function drive(ctx: ToolContext) {
  const d = ctx.app.integrations.drive();
  if (!d) throw new Error("Google Drive is not connected. Ask the owner to connect Google in Settings → Plugins.");
  return d;
}

const driveTools = [
  defineTool({
    name: "drive_search",
    label: "Search Google Drive",
    description: "Search the owner's Google Drive by file name and content. Returns file ids for drive_read.",
    parameters: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })) }),
    async run(args, ctx) {
      const files = await drive(ctx).search(args.query, args.max_results ?? 10);
      if (files.length === 0) return { text: "No matching files in Drive." };
      return {
        text: files.map((f) => `- ${f.id} | ${f.name} | ${f.mimeType.replace("application/vnd.google-apps.", "google ")} | modified ${f.modifiedTime ?? "?"}${f.webViewLink ? ` | ${f.webViewLink}` : ""}`).join("\n"),
        source: "Google Drive search",
      };
    },
  }),
  defineTool({
    name: "drive_read",
    label: "Read a Drive file",
    description: "Read a Google Drive file as text by id (Docs as text, Sheets as CSV, Slides as text, plain text files as is).",
    parameters: Type.Object({ file_id: Type.String() }),
    async run(args, ctx) {
      const { file, text } = await drive(ctx).read(args.file_id);
      ctx.app.threads.addRelated(ctx.thread.id, { kind: "page", title: file.name, url: file.webViewLink, ref: file.id });
      return { text: truncate(text, 20000), source: `Google Drive file "${file.name}"` };
    },
  }),
];

export const googlePlugin: PluginDef = {
  id: "google",
  name: "Google",
  description: "Google Calendar, Gmail and Drive. Connect your Google account; you can use your own OAuth client from Google Cloud Console instead of Vireo's.",
  author: "Vireo",
  homepage: "https://console.cloud.google.com/apis/credentials",
  fields: [
    {
      key: "client_id",
      label: "Client ID",
      type: "text",
      placeholder: "….apps.googleusercontent.com",
      pattern: "[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com",
      help: "Optional. Your own OAuth client (type “Web application”, with the redirect URI above); leave empty to use Vireo's.",
    },
    { key: "client_secret", label: "Client secret", type: "secret", placeholder: "GOCSPX-…", pattern: "GOCSPX-[A-Za-z0-9_-]{20,}" },
  ],
  // The owner signs in to Google Cloud and to their account; Vireo does the clicking in between.
  browserSetup: [
    `If the state above is login with a sign-in link, Vireo's shared client is ready: skip to the sign-in step (the one that says "browser_open it"). Create a client only when the state is setup, or the owner asks for their own.`,
    `Check the Redirect URI above. Google only accepts https addresses or http://localhost. If it is plain http on any other host, stop and tell the owner Google needs Vireo on HTTPS first (Tailscale's "Reach this host over the tailnet" gives it one), then wait for them.`,
    `Open ${CONSOLE}/projectcreate. If a sign-in page shows, call browser_ask_owner so the owner signs in to Google. Name the project "Vireo" and press Create (if the owner already has a project they want to use, select it instead). Wait until it is created and make sure it is the selected project at the top of the console.`,
    `Turn on the three APIs, one page each, pressing Enable when it shows (Manage means it is already on): ${CONSOLE}/apis/library/calendar-json.googleapis.com, ${CONSOLE}/apis/library/gmail.googleapis.com and ${CONSOLE}/apis/library/drive.googleapis.com. Check the project selector still shows the right project on each.`,
    `Set up the consent screen at ${CONSOLE}/auth/overview (Get started): app name "Vireo", the owner's Google address as support and contact email. For Audience pick Internal if it is offered (a Google Workspace account), otherwise External. Agree to the policy and press Create.`,
    `With External, open ${CONSOLE}/auth/audience. Ask the owner (in the thread, one short question) whether to publish the app: published, their sign-in keeps working but Google warns it is unverified when they connect; left in Testing, it needs no warning but the sign-in expires every 7 days. Publishing is the usual choice for a personal Vireo. If they pick Testing, add their Google address under Test users.`,
    `Create the client at ${CONSOLE}/auth/clients/create: Application type "Web application", name "Vireo", add the Redirect URI above exactly under Authorized redirect URIs, press Create. The dialog that follows shows the client ID and the client secret, and Google shows the secret only this once: call plugin_save_from_page with field client_id, then with field client_secret, before closing the dialog.`,
    `Call plugin_setup again: the state is now login with a sign-in link. browser_open it and call browser_ask_owner so the owner picks their account and allows Calendar, Gmail and Drive (on an unverified app they choose Advanced, then Go to Vireo). Call plugin_setup once more: it should be ready.`,
    `Tell the owner Google is connected and with which account; if the app stayed in Testing, say the sign-in lasts 7 days at a time.`,
  ],
  create(ctx) {
    const { host } = ctx;
    const auth = new GoogleAuth(
      ctx.state,
      () => {
        const c = ctx.config<GoogleConfig>();
        return c.client_id && c.client_secret ? { clientId: c.client_id, clientSecret: c.client_secret } : undefined;
      },
      (path, init) => host.cloud(path, init),
    );
    const redirectUri = (req?: RequestInfo) => `${host.publicUrl(req)}${CALLBACK}`;
    const live = () => !host.demo && auth.connected();
    // Several sign-ins can be under way (the owner's button, Vireo's browser); each keeps its own state.
    const pending = (): Pending[] => {
      const p = ctx.state.get<Pending[] | Pending>("pending");
      return (Array.isArray(p) ? p : p ? [p] : []).filter((x) => now() - (x.at ?? 0) < PENDING_TTL);
    };
    // The owner's own client when they made one, else Vireo's shared one, which sends Google's answer back through the cloud.
    const begin = async (callback: string, returnTo?: string) => {
      const state = newId("g");
      const own = auth.own();
      const shared = own ? undefined : await auth.shared();
      if (!own && !shared) throw new Error("Google OAuth client is not configured");
      if (shared) {
        const res = await host.cloud("/api/node/google/begin", { method: "POST", body: JSON.stringify({ state, callback }) });
        if (!res?.ok) throw new Error(`The Vireo cloud did not start the Google sign-in${res ? ` (${res.status})` : ""}. Try again.`);
      }
      const redirectUri = shared?.redirectUri ?? callback;
      ctx.state.set("pending", [...pending().slice(-4), { state, redirectUri, returnTo, shared: shared ? true : undefined, at: now() }]);
      return auth.authUrl(shared?.clientId ?? own!.clientId, redirectUri, state);
    };

    return {
      tools: driveTools,
      providers: {
        calendar: () => (live() ? new GoogleCalendar(auth) : undefined),
        mail: () => (live() ? new GoogleMail(auth) : undefined),
        drive: () => (live() ? new GoogleDrive(auth) : undefined),
      },
      grants: { general: ["drive_search", "drive_read"], research: ["drive_search", "drive_read"], email: ["drive_search", "drive_read"] },

      async status(req): Promise<PluginStatus> {
        if (host.demo) return { state: "ready", message: "Demo mode: in-memory calendar, mailbox and Drive." };
        const own = auth.own();
        const shared = own ? undefined : await auth.shared();
        // The redirect URI only matters to an owner making their own client.
        const details = shared ? [] : [{ label: "Redirect URI", value: redirectUri(req) }];
        if (!own && !shared) {
          return {
            state: "setup",
            message: "Create an OAuth client (type “Web application”) in Google Cloud Console, enable the Calendar, Gmail and Drive APIs, add the redirect URI below, then save the client ID and secret.",
            details,
          };
        }
        if (!auth.connected()) return { state: "login", message: "Connect your Google account.", details };
        const t = auth.tokens();
        const drive = auth.granted(DRIVE_SCOPE);
        return {
          state: "ready",
          message: drive ? `Connected${t?.email ? ` as ${t.email}` : ""}.` : `Connected${t?.email ? ` as ${t.email}` : ""}. Reconnect to allow Drive.`,
          details: [
            { label: "Calendar", value: "Google Calendar" },
            { label: "Email", value: "Gmail" },
            { label: "Drive", value: drive ? "Google Drive (read only)" : "not allowed yet" },
          ],
        };
      },

      actions() {
        if (host.demo || !auth.available()) return [];
        return auth.connected()
          ? [
              { id: "connect", label: "Reconnect" },
              { id: "disconnect", label: "Disconnect" },
            ]
          : [{ id: "connect", label: "Connect Google", primary: true }];
      },

      async runAction(id, req) {
        if (id === "disconnect") {
          auth.disconnect();
          return { message: "Disconnected." };
        }
        if (id === "connect") return { redirect: await begin(redirectUri(req), req.appOrigin ?? "") };
        throw new Error(`Unknown action: ${id}`);
      },

      async signInLink() {
        return host.demo || !(auth.own() ?? (await auth.shared())) ? undefined : begin(redirectUri());
      },

      // Google redirects here; the state parameter ties it to an authenticated request.
      publicRoutes(api) {
        api.get(CALLBACK, async (c) => {
          const state = c.req.query("state");
          const all = pending();
          const expected = state ? all.find((p) => p.state === state) : undefined;
          if (!expected) return c.text("Invalid or expired sign-in request.", 400);
          ctx.state.set("pending", all.filter((p) => p !== expected));
          const error = c.req.query("error");
          // Started in Vireo's browser: say so on the page the owner is looking at, then hand back.
          if (expected.returnTo === undefined) {
            if (error) return c.text(`Google sign-in did not finish (${error}). Hand the browser back to Vireo.`, 400);
            await auth.exchange(c.req.query("code") ?? "", expected.redirectUri, expected.shared ? expected.state : undefined);
            ctx.changed();
            return c.text("Google is connected to Vireo. Hand the browser back to Vireo.");
          }
          // Back to the Vireo app that started the sign-in.
          const back = `${expected.returnTo}/#settings/plugins`;
          if (error) return c.redirect(`${back}?google=${encodeURIComponent(error)}`);
          await auth.exchange(c.req.query("code") ?? "", expected.redirectUri, expected.shared ? expected.state : undefined);
          ctx.changed();
          return c.redirect(`${back}?google=connected`);
        });
      },

      secrets() {
        const t = auth.tokens();
        return [ctx.config<GoogleConfig>().client_secret, t?.access_token ?? "", t?.refresh_token ?? ""];
      },
    };
  },
};
