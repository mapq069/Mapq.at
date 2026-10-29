/* Service Worker der Familien-App: zeigt nur Benachrichtigungen an.
   Kein Caching – die App lädt immer die aktuelle Version. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (err) {}
    await self.registration.showNotification(d.title || 'Familie', {
      body: d.body || '',
      icon: '/familie/icon-192.png?v=3',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || '/familie/' }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/familie/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith('/familie')) {
        await w.focus();
        try { await w.navigate(url); } catch (err) {}
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
