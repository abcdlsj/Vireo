#!/usr/bin/env node
// Writes one deployment's Cloudflare ids into a config wrangler can deploy:
//
//   VIREO_D1_DATABASE_ID=... VIREO_GITHUB_CLIENT_ID=... node scripts/cloud-config.mjs
//   scripts/deploy-cf.sh apps/cloud --config wrangler.deploy.jsonc
//
// The ids belong to the deployment, not to the repository, and wrangler gives
// them no way to be told otherwise: it has no flag for the D1 database id and
// does not interpolate ${VARIABLES} in a config. So the tracked
// apps/cloud/wrangler.jsonc keeps placeholders and this writes a copy with the
// real values — git-ignored, so a checkout never carries them.
//
// The deployment pipeline passes both from repository variables; without either
// one this fails rather than deploying a placeholder.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps/cloud/wrangler.jsonc");
const target = join(root, "apps/cloud/wrangler.deploy.jsonc");

const replace = {
  PASTE_YOUR_D1_DATABASE_ID: process.env.VIREO_D1_DATABASE_ID,
  PASTE_YOUR_GITHUB_CLIENT_ID: process.env.VIREO_GITHUB_CLIENT_ID,
};

const unset = Object.entries(replace).filter(([, value]) => !value).map(([what]) => what);
if (unset.length) {
  const names = { PASTE_YOUR_D1_DATABASE_ID: "VIREO_D1_DATABASE_ID", PASTE_YOUR_GITHUB_CLIENT_ID: "VIREO_GITHUB_CLIENT_ID" };
  console.error(`${unset.map((what) => names[what]).join(" and ")} must be set; see .local/deploy.md.`);
  process.exit(1);
}

let config = readFileSync(source, "utf8");
for (const [what, value] of Object.entries(replace)) {
  if (!config.includes(what)) {
    console.error(`${source} no longer holds ${what}; it changed without this script.`);
    process.exit(1);
  }
  config = config.replaceAll(what, value);
}
writeFileSync(target, config);
console.log(`Wrote ${target}`);
