/**
 * The website as one page, in whichever language `t` is. The page reads like
 * an entry in a field guide: the name and its definition, a plate of the
 * board with numbered notes, the field marks, the song (how much Vireo does
 * not say), the habitat (where it lives), and how to get one.
 */

export const SITE = "https://askvireo.com";
export const APP = "https://app.askvireo.com";
export const REPO = "https://github.com/abcdlsj/vireo";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MARK = `<svg class="mark" viewBox="0 0 512 512" aria-hidden="true"><g transform="translate(-16 -8)"><path d="M104 372C104 232 214 140 344 140h40v56c0 112-88 192-200 192h-80z"/><path d="M384 140l56 28-56 28z"/><path d="M104 388c66-58 136-98 226-118" class="vein"/></g></svg>`;

/** Small line drawings beside each field mark, in the order of `marks`. */
const GLYPHS = [
  `<path d="M5 9h22M5 16h16M5 23h10"/><circle cx="24" cy="23" r="2.5"/>`,
  `<path d="M10 4h12v24l-6-4.5-6 4.5z"/><path d="M13.5 11h5"/>`,
  `<path d="M5 7h22v14H14l-6 5v-5H5z"/><path d="m11.5 14 3 3 6-6"/>`,
  `<path d="M4 17c0 6.5 5.4 10 12 10s12-3.5 12-10"/><path d="M3 17h26"/><ellipse cx="16" cy="12.5" rx="4" ry="4.5"/>`,
  `<path d="M12 4v7M20 4v7"/><path d="M8 11h16v5a8 8 0 0 1-16 0z"/><path d="M16 24v4"/>`,
  `<rect x="9.5" y="3.5" width="13" height="25" rx="3"/><path d="M14 24.5h4"/>`,
];

/** The song as a sonogram: a dense run of notes thinning out, then silence, then the one that matters. */
function sonogram() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const bars = [];
  const n = 150;
  for (let i = 0; i < n; i++) {
    const x = 4 + i * 4.2;
    const fade = 1 - i / n;
    if (rnd() > 0.35 + fade * 0.6) continue;
    const h = 6 + rnd() * 38 * (0.45 + fade * 0.55);
    bars.push(`<rect x="${x.toFixed(1)}" y="${(30 - h / 2).toFixed(1)}" width="2.2" height="${h.toFixed(1)}" rx="1.1" opacity="${(0.2 + fade * 0.8).toFixed(2)}"/>`);
  }
  return `<svg class="sono" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true"><g class="sono-bars">${bars.join("")}</g></svg><span class="sono-one"></span>`;
}

function board(t) {
  const m = t.mock;
  const hand = m.cards
    .map(
      (c, i) => `
          <article class="m-card ${c.pulse ? "is-working" : ""}">
            ${i === 1 ? '<span class="callout" style="--x:calc(100% - 12px);--y:-8px">3</span>' : ""}
            <h4>${esc(c.title)}</h4>
            ${c.pulse ? `<p class="m-pulse"><span class="dot"></span>${esc(c.pulse)}</p>` : `<p>${esc(c.text)}</p>`}
          </article>`,
    )
    .join("");
  return `
    <div class="m-board" aria-hidden="true">
      <div class="m-greet"><span>${esc(m.date)}</span><strong>${esc(m.headline)}</strong></div>
      <div class="m-head needs">${esc(m.needs)} <i>1</i><span class="callout" style="--x:-30px;--y:-2px">1</span></div>
      <article class="m-card m-mail">
        <div class="m-in">
          <div class="m-from"><span class="m-av">${esc(m.from.slice(0, 1))}</span><span><b>${esc(m.from)}</b><small>${esc(m.address)}</small></span></div>
          <h4>${esc(m.subject)}</h4>
          <p>${esc(m.body)}</p>
        </div>
        <div class="m-draft">
          <span class="m-label">${esc(m.replyLabel)}</span>
          <p>${esc(m.reply)}</p>
          <div class="m-buttons"><span class="m-btn primary">${esc(m.send)}</span><span class="m-btn">${esc(m.edit)}</span></div>
        </div>
      </article>
      <div class="m-head">${esc(m.hand)} <i>${m.cards.length}</i><span class="callout" style="--x:-30px;--y:-2px">2</span></div>
      <div class="m-grid">${hand}
      </div>
    </div>`;
}

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
<meta name="theme-color" content="#f3f1e8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171713" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
<script>
  // The app used to live here: its links (a node's link code, a thread) open in the app.
  if (/^#(link=|thread\\/|new|threads|settings|memory)/.test(location.hash)) location.replace("${APP}/" + location.hash);
</script>
</head>
<body>
<header class="top">
  <a class="brand" href="${t.path}">${MARK}<span>Vireo</span></a>
  <nav>
    <a href="#marks">${esc(t.nav.marks)}</a>
    <a href="#habitat">${esc(t.nav.habitat)}</a>
    <a href="#start">${esc(t.nav.start)}</a>
    <a class="lang" href="${other.path}" hreflang="${other.lang}" lang="${other.lang}" title="${esc(t.nav.otherLabel)}">${esc(t.nav.other)}</a>
    <a class="pill" href="${APP}">${esc(t.nav.app)}</a>
  </nav>
</header>

<main>
<section class="entry">
  <div class="entry-text">
    <p class="kicker">${esc(t.kicker)}</p>
    <h1 class="name">Vireo <span class="pron">/ˈvɪr.i.oʊ/</span></h1>
    <p class="pos"><i>${esc(t.pos)}</i> ${esc(t.def1)}</p>
    <p class="def">${esc(t.def2)}</p>
    <div class="cta">
      <a class="btn" href="${APP}">${esc(t.ctaApp)} <span aria-hidden="true">→</span></a>
      <span class="cta-or">${esc(t.ctaOr)}</span>
      <button class="cmd" type="button" data-copy="npx vireo-node" data-done="${esc(t.copied)}"><code><span class="prompt">$</span> npx vireo-node</code><span class="cmd-act">${esc(t.copy)}</span></button>
    </div>
  </div>
  <figure class="plate">
    <div class="plate-frame">${board(t)}
    </div>
    <figcaption><span class="plate-no">${esc(t.plate)}</span> ${esc(t.plateTitle)}</figcaption>
    <ol class="notes">
      ${t.notes.map(([h, p]) => `<li><b>${esc(h)}</b> ${esc(p)}</li>`).join("\n      ")}
    </ol>
  </figure>
</section>

<section class="marks" id="marks">
  <header class="sec-head"><h2>${esc(t.marksTitle)}</h2><p>${esc(t.marksLead)}</p></header>
  <ol class="mark-list">
    ${t.marks
      .map(
        ([h, p], i) =>
          `<li><svg class="glyph" viewBox="0 0 32 32" aria-hidden="true">${GLYPHS[i]}</svg><span class="no">${String(i + 1).padStart(2, "0")}</span><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`,
      )
      .join("\n    ")}
  </ol>
</section>

<section class="song">
  <div class="song-inner">
    <p class="kicker">${esc(t.songKicker)}</p>
    <p class="song-count">${esc(t.songCount)}</p>
    <p class="song-line">${esc(t.songLine)}</p>
    <p class="song-source"><a href="https://www.guinnessworldrecords.com/world-records/92739-most-songs-recorded-for-a-species-of-bird" rel="noreferrer">${esc(t.songSource)}</a></p>
    <div class="sono-wrap">${sonogram()}<span class="sono-label">${esc(t.songMark)}</span></div>
    <p class="song-quiet">${esc(t.songQuiet)}</p>
  </div>
</section>

<section class="habitat" id="habitat">
  <header class="sec-head"><h2>${esc(t.habitatTitle)}</h2><p>${esc(t.habitatLead)}</p></header>
  <ol class="pieces">
    ${t.pieces
      .map(
        (p, i) =>
          `<li class="${i === 0 ? "home" : ""}"><span class="piece-role">${esc(p.role)}</span><h3>${esc(p.name)}</h3><p>${esc(p.text)}</p>${p.tag ? `<span class="piece-tag">${esc(p.tag)}</span>` : ""}</li>`,
      )
      .join("\n    ")}
  </ol>
  <p class="habitat-note">${esc(t.habitatNote)}</p>
</section>

<section class="start" id="start">
  <header class="sec-head"><h2>${esc(t.startTitle)}</h2></header>
  <ol class="steps">
    ${t.steps
      .map(
        (s) =>
          `<li><p>${esc(s.text)}</p>${s.link ? `<a class="step-link" href="${APP}">${esc(s.link)} <span aria-hidden="true">→</span></a>` : ""}${
            s.cmd ? `<button class="cmd" type="button" data-copy="${esc(s.cmd)}" data-done="${esc(t.copied)}"><code><span class="prompt">$</span> ${esc(s.cmd)}</code><span class="cmd-act">${esc(t.copy)}</span></button>` : ""
          }</li>`,
      )
      .join("\n    ")}
  </ol>
  <p class="requires">${esc(t.requires)}</p>
</section>
</main>

<footer class="foot">
  <a class="brand" href="${t.path}">${MARK}<span>Vireo</span></a>
  <p class="etym">${esc(t.etym)}</p>
  <nav>
    <a href="${APP}">${esc(t.footer.app)}</a>
    <a href="${REPO}">${esc(t.footer.source)}</a>
    <a href="${REPO}/blob/main/deploy/README.md">${esc(t.footer.docs)}</a>
    <a href="${other.path}" hreflang="${other.lang}" lang="${other.lang}">${esc(t.nav.other)}</a>
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
