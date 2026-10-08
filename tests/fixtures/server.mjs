// Fixture web server for the end-to-end suite: a search endpoint, two
// articles to research, and a small restaurant site behind a sign-in page.
import { createServer } from "node:http";

const PORT = Number(process.env.FIXTURE_PORT ?? 8790);
const BASE = `http://localhost:${PORT}`;
const USER = "lisa";
const PASS = "s3cret-Pa55word!";
const submissions = [];

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const ARTICLES = {
  "vireo-bird": page(
    "Vireo — Bird Encyclopedia",
    `<article><h1>Vireo</h1><p>Vireos are small passerine birds found in the Americas, known for their persistent songs. The family Vireonidae includes about 60 species.</p><p>Most vireos are olive-green above and pale below, and many have spectacles or wing bars.</p></article>`,
  ),
  "vireo-name": page(
    "Where the name vireo comes from",
    `<article><h1>The name</h1><p>The word vireo comes from Latin and means a green migratory bird, related to virere, to be green. It entered English in the nineteenth century.</p></article>`,
  ),
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const send = (status, body, type = "text/html; charset=utf-8", headers = {}) => {
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(body);
  };
  const cookie = req.headers.cookie ?? "";

  if (url.pathname === "/search") {
    return send(
      200,
      JSON.stringify([
        { title: "Vireo — Bird Encyclopedia", url: `${BASE}/pages/vireo-bird`, snippet: "Vireos are small passerine birds…" },
        { title: "Where the name vireo comes from", url: `${BASE}/pages/vireo-name`, snippet: "Latin for a green migratory bird…" },
      ]),
      "application/json",
    );
  }
  if (url.pathname.startsWith("/pages/")) {
    const html = ARTICLES[url.pathname.slice(7)];
    return html ? send(200, html) : send(404, page("Not found", "Not found"));
  }
  if (url.pathname === "/login" && req.method === "GET") {
    return send(
      200,
      page(
        "Bistro Vireo — Sign in",
        `<h1>Sign in</h1><form method="post" action="/login"><label for="u">Email or username</label><input id="u" name="u" type="text"><label for="p">Password</label><input id="p" name="p" type="password"><button type="submit">Sign in</button></form>`,
      ),
    );
  }
  if (url.pathname === "/login" && req.method === "POST") {
    const form = await readBody(req);
    if (form.get("u") === USER && form.get("p") === PASS) return send(302, "", "text/plain", { location: "/booking", "set-cookie": "session=ok; Path=/" });
    return send(401, page("Sign in failed", "<p>Wrong username or password.</p><a href='/login'>Try again</a>"));
  }
  if (url.pathname === "/booking") {
    if (!cookie.includes("session=ok")) return send(302, "", "text/plain", { location: "/login" });
    return send(
      200,
      page(
        "Bistro Vireo — Book a table",
        `<h1>Book a table</h1><form method="post" action="/book">
          <label for="n">Name</label><input id="n" name="name" type="text">
          <label for="g">Guests</label><select id="g" name="guests"><option>1</option><option>2</option><option>3</option><option>4</option></select>
          <label for="d">Date</label><input id="d" name="date" type="text" placeholder="YYYY-MM-DD">
          <button type="submit">Book table</button></form>`,
      ),
    );
  }
  if (url.pathname === "/book" && req.method === "POST") {
    const form = await readBody(req);
    submissions.push(Object.fromEntries(form));
    return send(200, page("Booking confirmed", `<h1>Thank you</h1><p>Booking confirmed for ${form.get("name")}, ${form.get("guests")} guests on ${form.get("date")}.</p>`));
  }
  if (url.pathname === "/_submissions") return send(200, JSON.stringify(submissions), "application/json");
  if (url.pathname === "/_reset") {
    submissions.length = 0;
    return send(200, "{}", "application/json");
  }
  send(404, page("Not found", "Not found"));
});

server.listen(PORT, () => console.log(`fixtures on ${BASE}`));
export const fixture = { USER, PASS };
