const CACHE_NAME = "orange-hotel-shell-v6";

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  if (!request.url.startsWith(self.location.origin)) {
    return;
  }

  // Storage/API responses are live business data and must never come from the
  // app-shell cache. This is especially important when Firebase falls back to
  // the server sync route.
  if (new URL(request.url).pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Always prefer fresh app code so deployed fixes are not trapped behind stale caches.
  if (
    request.destination === "document" ||
    request.destination === "manifest" ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.url.includes("/_next/")
  ) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) {
        void fetch(request).then((response) => {
          if (response.ok) {
            void cache.put(request, response.clone());
          }
        }).catch(() => undefined);
        return cached;
      }

      const response = await fetch(request);
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    }),
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    }),
  );
});
