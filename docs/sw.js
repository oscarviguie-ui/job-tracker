// Present so the tracker can be installed as an app (and receive shared links on Android).
// It deliberately caches nothing: the tracker always loads fresh from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
