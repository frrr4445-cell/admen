const CACHE = "travel-touch-shell-v6";
const SHELL = ["/", "/index.html", "/login.html", "/register.html", "/profile.html", "/manifest.webmanifest", "/icon.svg"];
self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("travel-touch-") && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("message", event => {
  if (event.data?.type === "CLEAR_TRAVEL_TOUCH_CACHE") event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("travel-touch-")).map(k => caches.delete(k)))));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never cache authenticated, financial, API, account, or passenger pages/data.
  if (/\/api\/|checkout|payment|ticketWallet|checkin|dashboard|profile|support|admin|\.env|firestore/i.test(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: "no-store" });
        if (fresh.ok && SHELL.includes(url.pathname)) (await caches.open(CACHE)).put(request, fresh.clone());
        return fresh;
      } catch { return (await caches.match(request)) || (await caches.match("/index.html")); }
    })());
    return;
  }
  if (SHELL.includes(url.pathname) || /\.(?:css|js|svg|png|webp|woff2?)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      const network = fetch(request).then(response => {
        if (response.ok && url.origin === self.location.origin) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
