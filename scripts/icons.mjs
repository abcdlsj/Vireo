// Renders apps/web/public/icon.svg into the PNG icons the PWA manifest needs.
// Run with: node scripts/icons.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../apps/apps/web/public/icon.svg", import.meta.url), "utf8");
const out = (name) => new URL(`../apps/web/public/${name}`, import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
// [file, size, padding, opaque background]
for (const [name, size, pad, solid] of [
  ["icon-192.png", 192, 0, false],
  ["icon-512.png", 512, 0, false],
  ["apple-touch-icon.png", 180, 0, true],
  ["icon-maskable-512.png", 512, 0.1, true],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(
    `<html><body style="margin:0;background:${solid ? "#ffffff" : "transparent"};display:grid;place-items:center;height:${size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: out(name), omitBackground: !solid });
}
await browser.close();
console.log("icons written");
