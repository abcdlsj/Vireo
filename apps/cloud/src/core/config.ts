/** Cloud settings shared by every runtime; each value has a working default for local development. */
export interface CloudConfig {
  /** Where this service is reached, e.g. https://cloud.askvireo.com. Used for OAuth redirects and relay addresses. */
  publicUrl: string;
  /** Where the app is served; sign-in returns there and link pages open there. */
  webUrl: string;
  /** Other app origins allowed to call this service (e.g. preview deployments). */
  extraOrigins: string[];
  github?: { clientId: string; clientSecret: string };
  /** GitHub's endpoints, overridable for tests. */
  githubUrls: { authorize: string; token: string; api: string };
  /** Sign in by name without GitHub. Development and tests only. */
  devLogin: boolean;
  /** Lifetime of a node access token. */
  accessTtlMs: number;
}

export type Env = Record<string, string | undefined>;

function bool(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase());
}

const strip = (u: string) => u.replace(/\/+$/, "");

export function parseConfig(env: Env, fallbackUrl: string): CloudConfig {
  const publicUrl = strip(env.VIREO_CLOUD_URL || fallbackUrl);
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined;
  return {
    publicUrl,
    webUrl: strip(env.VIREO_WEB_URL || publicUrl),
    extraOrigins: (env.VIREO_WEB_ORIGINS ?? "")
      .split(",")
      .map((o) => strip(o.trim()))
      .filter(Boolean),
    github,
    githubUrls: {
      authorize: env.VIREO_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
      token: env.VIREO_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
      api: env.VIREO_GITHUB_API_URL ?? "https://api.github.com",
    },
    devLogin: bool(env.VIREO_DEV_LOGIN),
    accessTtlMs: Number(env.VIREO_ACCESS_TTL_MS || 15 * 60_000),
  };
}
