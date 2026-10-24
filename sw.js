// Terra Incognita service worker (build b7b163fbbd20). Precaches the loader, the sealed
// game blob, the manifest and icons for offline play; each build gets its own cache and
// older ones are deleted on activation. Google Fonts are cached at runtime.
// Audio (public, unencrypted) is cached on first use: the first sound the game fetches
// tells us its format (m4a or ogg), and the rest of that format is then fetched in the
// background, so a game played online once also has its sounds offline. The audio cache
// is keyed by the audio content hash, so releases that don't change sounds keep it.
const VERSION = 'b7b163fbbd20';
const CACHE = 'ti-' + VERSION;
const FONTS = 'ti-fonts';
const AUDIO = 'ti-audio-335849f6d2f7';
const AUDIO_DIR = new URL('audio/', self.location).pathname;
const PRECACHE = ["./","manifest.webmanifest","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-192.png","icons/maskable-512.png","icons/favicon-64.png","game.7f9f325f2abf.bin"];
const HASHED = ["game.7f9f325f2abf.bin"]; // content-addressed files: safe to take from the HTTP cache

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (url) => {
          const res = await fetch(new Request(url, { cache: HASHED.includes(url) ? 'default' : 'reload' }));
          if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
          await cache.put(url, res);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('ti-') && ![CACHE, FONTS, AUDIO].includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

async function audioResponse(req) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) await cache.put(req, res.clone());
  return res;
}

const warmed = new Set();
async function warmAudio(ext) {
  try {
    const cache = await caches.open(AUDIO);
    const mUrl = AUDIO_DIR + 'manifest.json';
    let mRes = await cache.match(mUrl);
    if (!mRes) {
      mRes = await fetch(mUrl);
      if (!mRes.ok) return;
      await cache.put(mUrl, mRes.clone());
    }
    const manifest = await mRes.json();
    const urls = [...new Set(Object.values(manifest.entries || {}).map((e) => e.files && e.files[ext]).filter(Boolean))].map((f) => AUDIO_DIR + f);
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        if (await cache.match(u)) continue;
        try {
          const r = await fetch(u);
          if (r.ok && r.status === 200) await cache.put(u, r);
        } catch {
          return; // offline: try again next time
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch {
    warmed.delete(ext);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // Network first (so new builds show up), the cached loader when offline or very slow.
      event.respondWith(
        (async () => {
          const cached = caches.open(CACHE).then((c) => c.match('./'));
          const net = fetch(req).catch(() => null);
          const first = await Promise.race([net, timeout(4000)]);
          if (first && first.ok) return first;
          return (await cached) || (await net) || Response.error();
        })(),
      );
      return;
    }
    if (url.pathname.startsWith(AUDIO_DIR)) {
      event.respondWith(audioResponse(req));
      const ext = (url.pathname.match(/\.(m4a|ogg)$/) || [])[1];
      if (ext && !warmed.has(ext)) {
        warmed.add(ext);
        event.waitUntil(warmAudio(ext));
      }
      return;
    }
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONTS);
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return hit || (await net) || Response.error();
      })(),
    );
  }
});
