"use strict";
// Offline app shell. API calls are never cached here: the app keeps its own data cache and sync queue.
var CACHE = "pond-ledger-v3";
var SHELL = ["./", "index.html", "app.css", "app.js", "i18n.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !fonts) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(function (r) {
      var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put("index.html", copy); }); return r;
    }).catch(function () { return caches.match("index.html"); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (r) {
      if (r && (r.ok || r.type === "opaque")) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return r;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});
