const CACHE_NAME = 'meter-log-v4';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
];

// ── Install & Activate ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch (cache-first) ───────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── IndexedDB helper（アプリ側と同じ DB を読む） ──────────────
function idbGet(key) {
  return new Promise(res => {
    const req = indexedDB.open('meter-notif-db', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', {keyPath:'k'});
    };
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) { res(null); return; }
      const tx = db.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get(key);
      get.onsuccess = () => res(get.result ?? null);
      get.onerror = () => res(null);
    };
    req.onerror = () => res(null);
  });
}

// ── Periodic Background Sync ──────────────────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'weekly-check') {
    event.waitUntil(handleWeeklyCheck());
  }
});

async function handleWeeklyCheck() {
  const now = new Date();
  const day  = now.getDay();   // 0=日, 1=月
  const hour = now.getHours();

  // 日曜 20時以降：未記録リマインド
  if (day === 0 && hour >= 20) {
    const missingRec = await idbGet('missing-days');
    const missing = missingRec?.value ?? 0;
    if (missing > 0) {
      await self.registration.showNotification('🚗 メーター記録リマインド', {
        body: `今週の車両日報に未記録が ${missing} 日あります。アプリを開いて入力してください。`,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'sunday-reminder',
        requireInteraction: false,
      });
    }
  }

  // 月曜 8〜10時：先週のサマリー通知
  if (day === 1 && hour >= 8 && hour < 10) {
    const summaryRec = await idbGet('weekly-summary');
    if (summaryRec?.text) {
      // 同じ週に何度も送らないよう IDB にフラグ保存
      const sentKey = `monday-sent-${summaryRec.week}`;
      const alreadySent = await idbGet(sentKey);
      if (!alreadySent) {
        await self.registration.showNotification('📋 今週の車両週報', {
          body: summaryRec.text.split('\n').slice(0, 4).join('\n') + (summaryRec.text.split('\n').length > 4 ? '\n…' : ''),
          icon: './icons/icon-192.png',
          badge: './icons/icon-192.png',
          tag: 'monday-summary',
          requireInteraction: true,
        });
        // 送信済みフラグを書き込む
        const req = indexedDB.open('meter-notif-db', 1);
        req.onsuccess = e => {
          const tx = e.target.result.transaction('kv','readwrite');
          tx.objectStore('kv').put({k: sentKey, value: true});
        };
      }
    }
  }
}

// ── 通知タップ → アプリを開く ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
      for (const client of list) {
        if (client.url.includes('index.html') && 'focus' in client) return client.focus();
      }
      return clients.openWindow('./index.html');
    })
  );
});
