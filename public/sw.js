const SHELL_CACHE = "chathelp-shell-v1";
const STATIC_CACHE = "chathelp-static-v1";
const SHELL = ["/", "/offline.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith("chathelp-") && ![SHELL_CACHE, STATIC_CACHE].includes(name)).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) {
        const cacheCopy = response.clone();
        try { await (await caches.open(SHELL_CACHE)).put(request, cacheCopy); } catch { /* A cache failure must not block the live page. */ }
      }
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match("/")) || caches.match("/offline.html")));
    return;
  }

  const cacheable = ["/_next/static/", "/tesseract/", "/tesseract-core/", "/tessdata/"].some((prefix) => url.pathname.startsWith(prefix)) || ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"].includes(url.pathname);
  if (!cacheable) return;

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then(async (response) => {
    if (response.ok) {
      const cacheCopy = response.clone();
      try { await (await caches.open(STATIC_CACHE)).put(request, cacheCopy); } catch { /* Continue with the network response. */ }
    }
    return response;
  })));
});
