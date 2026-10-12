// Builds askvireo.com into dist/: one page per language from the same
// template, the stylesheet, the screenshots, the fonts and the icons. `npm run build`.
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { notFound, page } from "./src/page.mjs";
import { strings } from "./src/strings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);
const font = (pkg, file) => join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "zh"), { recursive: true });
mkdirSync(join(out, "fonts"), { recursive: true });

const { en, zh } = strings;
writeFileSync(join(out, "index.html"), page(en, zh));
writeFileSync(join(out, "zh", "index.html"), page(zh, en));
writeFileSync(join(out, "404.html"), notFound(en, zh));

copyFileSync(join(here, "src", "site.css"), join(out, "site.css"));
copyFileSync(join(here, "src", "_headers"), join(out, "_headers"));
copyFileSync(join(here, "src", "og.png"), join(out, "og.png"));
copyFileSync(join(here, "src", "install.sh"), join(out, "install.sh"));
cpSync(join(here, "src", "img"), join(out, "img"), { recursive: true });
copyFileSync(font("@fontsource-variable/manrope", "manrope-latin-wght-normal.woff2"), join(out, "fonts", "manrope.woff2"));
copyFileSync(font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2"), join(out, "fonts", "inter.woff2"));
for (const f of ["icon.svg", "apple-touch-icon.png"]) copyFileSync(join(here, "..", "web", "public", f), join(out, f));

console.log("Built the site into dist/");
