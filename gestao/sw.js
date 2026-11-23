const CACHE_NAME = 'morangos-gestao-v3';
const APP_SHELL = [
  '/',
  '/?v=2',
  '/index.html',
  '/manifest-v2.webmanifest?v=2',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico'
];
const SDK_ASSETS = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'accounts.google.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'viacep.com.br',
  'brasilapi.com.br',
  'nominatim.openstreetmap.org',
  'router.project-osrm.org',
  'api.heigit.org'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      APP_SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })))
    );
    await Promise.allSettled(
      SDK_ASSETS.map(url => cache.add(new Request(url, { mode: 'cors' })))
    );
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCacheableStatic(url) {
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) return true;
  if (url.hostname === 'fonts.gstatic.com') return true;
  if (url.hostname === 'cdnjs.cloudflare.com') return true;
  if (url.origin === self.location.origin && /\.(?:png|jpg|jpeg|webp|svg|ico|webmanifest|css|js)$/i.test(url.pathname)) return true;
  return false;
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.pathname.startsWith('/__/')) return;
  if (BYPASS_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;

  if (isCacheableStatic(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const netPromise = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      if (cached) {
        event.waitUntil(netPromise);
        return cached;
      }
      const res = await netPromise;
      return res || new Response('', { status: 504, statusText: 'Offline' });
    })());
    return;
  }

  if (url.origin === self.location.origin && (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/gestao'))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetchWithTimeout(req, 2800);
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (res && res.ok && !res.redirected && ct.includes('text/html')) {
          cache.put('/index.html', res.clone()).catch(() => {});
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (_) {
        const cached =
          await cache.match(req) ||
          await cache.match('/index.html') ||
          await cache.match('/') ||
          await cache.match('/?v=2');
        return cached || new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:24px"><h2>Sem conexão</h2><p>Abra o app ao menos uma vez conectado à internet para salvar a cópia offline.</p></body>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }
});
