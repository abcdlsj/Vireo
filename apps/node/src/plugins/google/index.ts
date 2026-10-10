import { Type } from "typebox";
import { defineTool, type ToolContext } from "../../tools/types.js";
import { newId, truncate } from "../../util.js";
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
  description: "Google Calendar, Gmail and Drive. Uses an OAuth client you create in Google Cloud Console.",
  author: "Vireo",
  homepage: "https://console.cloud.google.com/apis/credentials",
  fields: [
    { key: "client_id", label: "Client ID", type: "text", placeholder: "….apps.googleusercontent.com" },
    { key: "client_secret", label: "Client secret", type: "secret" },
  ],
  create(ctx) {
    const { host } = ctx;
    const auth = new GoogleAuth(ctx.state, () => {
      const c = ctx.config<GoogleConfig>();
      return c.client_id && c.client_secret ? { clientId: c.client_id, clientSecret: c.client_secret } : undefined;
    });
    const redirectUri = (req?: RequestInfo) => `${host.publicUrl(req)}${CALLBACK}`;
    const live = () => !host.demo && auth.connected();

    return {
      tools: driveTools,
      providers: {
        calendar: () => (live() ? new GoogleCalendar(auth) : undefined),
        mail: () => (live() ? new GoogleMail(auth) : undefined),
        drive: () => (live() ? new GoogleDrive(auth) : undefined),
      },
      grants: { general: ["drive_search", "drive_read"], research: ["drive_search", "drive_read"], email: ["drive_search", "drive_read"] },

      async status(req): Promise<PluginStatus> {
        const details = req ? [{ label: "Redirect URI", value: redirectUri(req) }] : [];
        if (host.demo) return { state: "ready", message: "Demo mode: in-memory calendar, mailbox and Drive." };
        if (!auth.client()) {
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
        if (host.demo || !auth.client()) return [];
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
        if (id === "connect") {
          const state = newId("g");
          const uri = redirectUri(req);
          ctx.state.set("pending", { state, redirectUri: uri, returnTo: req.appOrigin ?? "" });
          return { redirect: auth.authUrl(uri, state) };
        }
        throw new Error(`Unknown action: ${id}`);
      },

      // Google redirects here; the state parameter ties it to an authenticated request.
      publicRoutes(api) {
        api.get(CALLBACK, async (c) => {
          const state = c.req.query("state");
          const expected = ctx.state.get<{ state: string; redirectUri: string; returnTo?: string }>("pending");
          if (!state || !expected || expected.state !== state) return c.text("Invalid or expired sign-in request.", 400);
          ctx.state.delete("pending");
          const error = c.req.query("error");
          // Back to the Vireo app that started the sign-in.
          const back = `${expected.returnTo ?? ""}/#settings/plugins`;
          if (error) return c.redirect(`${back}?google=${encodeURIComponent(error)}`);
          await auth.exchange(c.req.query("code") ?? "", expected.redirectUri);
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
