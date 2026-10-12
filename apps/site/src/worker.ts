/**
 * askvireo.com. The pages are static assets; this only sends www to the
 * bare domain first, keeping the path (the app lives on app.askvireo.com).
 */
interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
