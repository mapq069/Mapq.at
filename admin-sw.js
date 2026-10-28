/* Service Worker der mapq-Admin-App: zeigt nur Push-Benachrichtigungen an.
   Kein Caching – das Panel lädt immer die aktuelle Version. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (err) {}
    await self.registration.showNotification(d.title || 'mapq.at', {
      body: d.body || '',
      icon: '/admin-icon-192.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || '/admin.html#inquiries' }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/admin.html', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith('/admin')) {
        await w.focus();
        try { await w.navigate(url); } catch (err) {}
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
