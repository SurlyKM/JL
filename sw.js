'use strict';
/* Offline support: caches the app's own files so it opens with no signal.
   It never touches requests to other sites (the flight lookup goes straight to the network).
   Bump VERSION whenever any app file changes so phones pick up the new files. */
const VERSION = 'jl-v1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'logic.js', 'airports.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // leave other sites alone
  if (req.mode === 'navigate') {
    // Page loads: cached page first (works offline), refresh the cache in the background.
    e.respondWith(caches.match('index.html').then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok) caches.open(VERSION).then(c => c.put('index.html', res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
