// ═══════════════════════════════════════════════════════════
//  ทศพร ผลไม้ — Service Worker
//  หน้าที่เดียว: เก็บไฟล์แอปไว้ในเครื่อง เปิดครั้งต่อไปไม่ต้องรอเน็ต
//
//  วิธีทำงาน (stale-while-revalidate):
//    1. เปิดแอป → เสิร์ฟไฟล์จากเครื่องทันที ไม่รอเน็ตเลย
//    2. พร้อมกันนั้นไปดึงไฟล์ใหม่มาเก็บทับเงียบๆ
//    3. เปิดครั้งถัดไปได้ตัวใหม่ (และระบบเช็คเวอร์ชันในแอปจะเตือนให้รีเฟรชเอง)
//
//  ไม่แตะข้อมูล Firebase เลย — RTDB คุยผ่าน WebSocket ซึ่ง Service Worker ดักไม่ได้
//  และเราข้ามทุก request ที่ไม่ใช่โดเมนตัวเอง
// ═══════════════════════════════════════════════════════════

const CACHE = "tossaporn-shell-v1";

self.addEventListener("install", e => {
  // ไม่รอ SW ตัวเก่าปิด — ให้ตัวใหม่ทำงานเลย
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(["./", "./index.html"]))
      .catch(() => {})   // ถ้าเก็บไม่ได้ ก็แค่ทำงานแบบไม่มี cache ไม่พัง
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // ข้ามทุกอย่างที่ไม่ใช่ไฟล์ของเรา — Firebase, ฟอนต์, CDN ปล่อยผ่านตามปกติ
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });

      // ไปดึงตัวใหม่มาเก็บทับ (ทำเบื้องหลัง ไม่บล็อกการเสิร์ฟ)
      const fresh = fetch(req).then(res => {
        if (res && res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);

      if (cached) {
        e.waitUntil(fresh);   // ให้ SW อยู่ต่อจนดึงเสร็จ
        return cached;        // เสิร์ฟจากเครื่องทันที
      }
      return (await fresh) || fetch(req);
    } catch (err) {
      return fetch(req);
    }
  })());
});

// ให้หน้าแอปสั่งล้าง cache ได้ เผื่อต้องบังคับอัปเดต
self.addEventListener("message", e => {
  if (e.data === "clearShell") {
    caches.delete(CACHE).then(() => self.registration.unregister()).catch(() => {});
  }
});
