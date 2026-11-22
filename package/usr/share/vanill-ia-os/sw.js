/**
 * ==============================================================================
 * Vanill-IA OS — Progressive Web App Service Worker (sw.js)
 * - Never caches /api/* (strict security & real-time telemetry)
 * - Stale-While-Revalidate on static UI assets (/assets/*)
 * - Network-First on HTML navigation with instant fallback to /offline.html
 *   during Debian server reboot or temporary network loss
 * ==============================================================================
 */

const CACHE_VERSION = 'vanill-ia-os-v1.6.2';
const OFFLINE_URL = '/offline.html';

const PRECACHE_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/assets/css/desktop.css',
  '/assets/js/i18n.js',
  '/assets/lang/en.json',
  '/assets/lang/fr.json',
  '/assets/js/core/ApiClient.js',
  '/assets/js/core/QrCode.js',
  '/assets/js/core/WindowManager.js',
  '/assets/js/core/Desktop.js',
  '/assets/js/apps/docker-manager.js',
  '/assets/js/apps/resource-monitor.js',
  '/assets/js/apps/system-settings.js',
  '/assets/js/apps/cron-manager.js',
  '/assets/js/apps/file-station.js',
  '/assets/js/apps/mount-manager.js',
  '/assets/js/apps/web-browser.js',
  '/assets/js/apps/code-editor.js',
  '/assets/js/apps/notes.js',
  '/assets/js/apps/terminal.js',
  '/assets/js/apps/vanill-ia-chat.js',
  '/assets/img/icons/logo.svg',
  '/assets/img/pwa/icon-192.png',
  '/assets/img/pwa/icon-512.png',
  '/assets/img/pwa/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((oldKey) => caches.delete(oldKey))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Zéro mise en cache sur les endpoints API et authentification
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigation principale : Network-First -> fallback offline.html (ex: reboot serveur)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        const offlineFallback = await cache.match(OFFLINE_URL);
        return (
          offlineFallback ||
          new Response('Serveur en cours de redémarrage...', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        );
      })
    );
    return;
  }

  // Assets statiques : Stale-While-Revalidate
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
  }
});
