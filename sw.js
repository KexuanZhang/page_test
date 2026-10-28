// Offline support: the app shell is cached on install; the heavy specimen data is cached the first time it is used.
const CACHE = 'squish-lab-v1';
const DATA = ["data/bubble.json", "data/bubble.wasm", "data/choc.json", "data/choc.wasm", "data/jelly.json", "data/jelly.wasm", "data/mochi.json", "data/mochi.wasm", "data/watermelon.json", "data/watermelon.wasm"];
const CORE = ["./", "audio.js", "crumb.js", "crumbsurf.js", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "main.js", "manifest.webmanifest", "pieces.js", "regions.js", "shaders.js", "sim.js", "simopts.js", "sounds/CREDITS.txt", "sounds/bite_apple.mp3", "sounds/drip_01.mp3", "sounds/drip_03.mp3", "sounds/index.json", "sounds/pop_10.mp3", "sounds/pop_2.mp3", "sounds/pop_4.mp3", "sounds/pop_8.mp3", "sounds/pop_9.mp3", "sounds/pop_bp.mp3", "sounds/splat_03.mp3", "sounds/splat_04.mp3", "sounds/splat_07.mp3", "sounds/splat_08.mp3", "sounds/squish_01_0.mp3", "sounds/squish_02.mp3", "sounds/squish_03.mp3", "sounds/squish_04.mp3", "sounds/squish_05.mp3", "sounds/squish_06.mp3", "sounds/squishpop.mp3", "sounds/squishsplat_impact.mp3", "sounds/wet_01.mp3", "sounds/wet_02.mp3", "sounds/wet_04.mp3", "sounds/wet_05.mp3", "sounds/wet_07.mp3", "sounds/wet_08.mp3", "sounds/wet_09.mp3", "sounds/wet_11.mp3", "sounds/wet_13.mp3", "sounds/wet_15.mp3", "vendor/addons/environments/RoomEnvironment.js", "vendor/three.module.js"];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()).then(() => caches.open(CACHE)).then((c) => Promise.all(DATA.map((u) => c.match(u).then((m) => m || c.add(u).catch(() => {})))))); });   // then fetch every specimen, so the whole app works offline
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && (new URL(req.url).origin === location.origin || req.url.includes('fonts.g'))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => Response.error())));
});
