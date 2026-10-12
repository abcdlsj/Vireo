/* Vireo service worker: offline app shell and push notifications. */
const CACHE = "vireo-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || /^\/(api|n|auth|\.well-known)\//.test(url.pathname)) return;
  // Network first so updates show immediately; fall back to the cached shell offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Vireo", body: "", url: "/" };
  try {
    data = { ...data, ...event.data.json() };
  } catch (_) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/", decide: data.decide },
      // Answer a confirmation from the notification itself, where the platform shows buttons.
      actions: data.decide
        ? [
            { action: "confirm", title: "Confirm" },
            { action: "cancel", title: "Decline" },
          ]
        : undefined,
      requireInteraction: Boolean(data.decide),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const decide = event.notification.data && event.notification.data.decide;
  if (decide && (event.action === "confirm" || event.action === "cancel")) {
    const title = event.notification.title;
    event.waitUntil(
      fetch(decide[event.action], { method: "POST" })
        .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
        .then(({ ok, body }) => {
          const done = { done: "Confirmed", executing: "Confirmed", failed: "Confirmed, but it failed", cancelled: "Declined" }[body.status];
          return self.registration.showNotification(ok && done ? done : "Couldn't record that", {
            body: ok ? body.summary || title : body.error || "Open Vireo to answer it.",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            data: { url: event.notification.data.url },
          });
        })
        .catch(() => self.registration.showNotification("Couldn't reach Vireo", { body: "Open Vireo to answer it.", data: { url: event.notification.data.url } })),
    );
    return;
  }
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.postMessage({ type: "navigate", url: target });
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
