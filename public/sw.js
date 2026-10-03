// 가까운 전시 — 알림 전용 서비스 워커 (화면·데이터 캐시는 하지 않음)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '가까운 전시', {
    body: d.body || '', tag: d.tag || 'deadline', renotify: true,
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/#my' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#my', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) {
      if (w.url.startsWith(self.location.origin)) {
        w.postMessage({ type: 'open', hash: new URL(url).hash });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
