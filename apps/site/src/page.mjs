/**
 * The website as one page, in whichever language `t` is: one line, the
 * button, and the app itself in screenshots (taken from the real app, in
 * the page's language).
 */

export const SITE = "https://askvireo.com";
export const APP = "https://app.askvireo.com";
export const REPO = "https://github.com/abcdlsj/vireo";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MARK = `<svg class="mark" viewBox="0 0 512 512" aria-hidden="true"><g transform="translate(-16 -8)"><path d="M104 372C104 232 214 140 344 140h40v56c0 112-88 192-200 192h-80z"/><path d="M384 140l56 28-56 28z"/><path d="M104 388c66-58 136-98 226-118" class="vein"/></g></svg>`;

/** A desktop screenshot (the board is 2400×1500, the thread a 1500×1240 crop), with its dark-mode twin. */
const desk = (name, t, alt, [w, h]) => `<picture><source media="(prefers-color-scheme: dark)" srcset="/img/dark-${name}-${t.img}.webp"><img src="/img/${name}-${t.img}.webp" width="${w}" height="${h}" alt="${esc(alt)}" ${name === "board" ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></picture>`;

/** A phone screenshot, 900×1948, with its dark-mode twin. */
const phone = (name, t, alt) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="/img/dark-${name}-${t.img}.webp"><img src="/img/${name}-${t.img}.webp" width="900" height="1948" alt="${esc(alt)}" loading="lazy" decoding="async"></picture>`;

/** Sets up a node as a background service, Node.js included when the machine has none (src/install.sh). */
const INSTALL = `curl -fsSL ${SITE}/install.sh | sh`;

const copyCmd = (t) =>
  `<button class="cmd" type="button" data-copy="${esc(INSTALL)}" data-done="${esc(t.copied)}" title="${esc(INSTALL)}"><code><span class="prompt">$</span> ${esc(INSTALL)}</code><span class="cmd-act">${esc(t.copy)}</span></button>`;

export function page(t, other) {
  const alt = (l) => `${SITE}${l.path}`;
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.description)}">
<link rel="canonical" href="${alt(t)}">
<link rel="alternate" hreflang="${t.lang}" href="${alt(t)}">
<link rel="alternate" hreflang="${other.lang}" href="${alt(other)}">
<link rel="alternate" hreflang="x-default" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.description)}">
<meta property="og:url" content="${alt(t)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f8f8f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#191919" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/manrope.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header class="top">
  <a class="brand" href="${t.path}">${MARK}<span>Vireo</span></a>
  <nav>
    <a class="lang" href="${other.path}" hreflang="${other.lang}" lang="${other.lang}" title="${esc(t.otherLabel)}">${esc(t.other)}</a>
    <a class="pill" href="${APP}">${esc(t.app)}</a>
  </nav>
</header>

<main>
<section class="hero">
  <h1>${t.headline.map(esc).join(" <br>")}</h1>
  <div class="cta">
    <a class="btn" href="${APP}">${esc(t.app)}</a>
    ${copyCmd(t)}
  </div>
</section>

<figure class="shot shot-board">${desk("board", t, t.boardAlt, [2400, 1500])}</figure>

<section class="pair">
  <h2>${t.confirm.map(esc).join("<br>")}</h2>
  <figure class="shot">${desk("thread", t, t.threadAlt, [1500, 1240])}</figure>
</section>

<section class="pair phones">
  <h2>${t.phone.map(esc).join("<br>")}</h2>
  <div class="phone-row">
    <figure class="shot phone">${phone("phone-board", t, t.phoneAlt[0])}</figure>
    <figure class="shot phone">${phone("phone-thread", t, t.phoneAlt[1])}</figure>
  </div>
</section>

<section class="end">
  <ul class="facts">${t.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
  <div class="cta">
    <a class="btn" href="${APP}">${esc(t.app)}</a>
    ${copyCmd(t)}
  </div>
</section>
</main>

<footer class="foot">
  <a class="brand" href="${t.path}">${MARK}<span>Vireo</span></a>
  <nav>
    <a href="${REPO}">GitHub</a>
    <a href="${REPO}/blob/main/deploy/README.md">${esc(t.docs)}</a>
    <a href="${other.path}" hreflang="${other.lang}" lang="${other.lang}">${esc(t.other)}</a>
  </nav>
</footer>

<script>
  for (const b of document.querySelectorAll("[data-copy]")) {
    b.addEventListener("click", async () => {
      const label = b.querySelector(".cmd-act");
      const was = label.textContent;
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        label.textContent = b.dataset.done;
        setTimeout(() => (label.textContent = was), 1600);
      } catch {}
    });
  }
</script>
</body>
</html>
`;
}

export function notFound(t, other) {
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vireo</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
</head>
<body class="lost">
<main>
  <a class="brand" href="/">${MARK}<span>Vireo</span></a>
  <h1>${esc(t.notFound)}</h1>
  <p lang="${other.lang}">${esc(other.notFound)}</p>
  <a class="btn" href="/">${esc(t.notFoundBack)} <span aria-hidden="true">→</span></a>
</main>
</body>
</html>
`;
}
