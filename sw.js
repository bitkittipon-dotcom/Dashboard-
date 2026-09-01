/* ═══════════════════════════════════════════════════════════════
   ทศพร ผลไม้ — Service Worker  (v2)
   คู่กับ index.html · วางไว้โฟลเดอร์เดียวกับ index.html

   หลักการ:
     · ตัวแอป (index.html) → เสิร์ฟจากเครื่องทันที ไม่รอเน็ต
       แล้วไปดึงตัวใหม่มาเก็บทับเบื้องหลัง (stale-while-revalidate)
       เปิดครั้งถัดไปได้ตัวใหม่ · ระบบเช็คเวอร์ชันในแอปจะเตือนให้รีเฟรชเอง
     · Firebase SDK → เก็บล่วงหน้าตั้งแต่ติดตั้ง
       เพราะถ้า 3 ไฟล์นี้โหลดไม่ได้ แอปจะขึ้นจอ "โหลด Firebase ไม่ได้" แล้วจบเลย
       เก็บแต่ index.html อย่างเดียวจึงไม่พอ ออฟไลน์ก็ยังเปิดไม่ได้อยู่ดี
     · ไฟล์ CDN อื่น (Chart.js, html2canvas, ฟอนต์) → เก็บตอนใช้จริง
     · ข้อมูลสด (Firebase RTDB / Auth / api.anthropic.com) → ไม่แตะเลย
   ═══════════════════════════════════════════════════════════════ */

const SW_VERSION  = "v2";
const SHELL_CACHE = `tospon-shell-${SW_VERSION}`;   // ตัวแอป
const ASSET_CACHE = `tospon-asset-${SW_VERSION}`;   // ไฟล์ CDN

/* เก็บล่วงหน้าตอนติดตั้ง — เฉพาะ Firebase SDK (ไม่กี่ร้อย KB)
   ไม่เก็บ index.html ตอนนี้ (ใหญ่ 1 MB) — ปล่อยให้เก็บตอนเปิดจริงครั้งแรก */
const PRECACHE = [
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js",
];

/* โดเมนที่เก็บไว้ในเครื่องได้ — ทุก URL ล็อกเลขเวอร์ชันไว้แล้ว ไม่เปลี่ยนกลางทาง */
const ASSET_HOSTS = [
  "www.gstatic.com",        // firebasejs 9.23.0
  "cdnjs.cloudflare.com",   // Chart.js 4.4.1, html2canvas 1.4.1
  "fonts.googleapis.com",   // ไฟล์ CSS ของฟอนต์
  "fonts.gstatic.com",      // ตัวฟอนต์
];

/* ห้ามแตะเด็ดขาด — เป็นข้อมูลสด ถ้าเก็บไว้จะได้ยอดเงินเก่า
   (RTDB ส่วนใหญ่คุยผ่าน WebSocket ซึ่ง SW ดักไม่ได้อยู่แล้ว
    แต่บางเครือข่ายมันถอยไปใช้ long-polling ที่ดักได้ — กันไว้ให้ครบ) */
const NEVER_TOUCH = [
  "firebasedatabase.app",
  "firebaseio.com",
  "identitytoolkit",
  "securetoken",
  "api.anthropic.com",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const c = await caches.open(ASSET_CACHE);
      // ทีละไฟล์ ไม่ใช่ addAll — ถ้าตัวใดตัวหนึ่งพลาด ตัวอื่นยังเก็บได้
      await Promise.all(PRECACHE.map(async u => {
        try {
          const res = await fetch(u, { mode: "no-cors" });
          if (res && (res.ok || res.type === "opaque")) await c.put(u, res.clone());
        } catch (e) { /* เน็ตไม่ดีตอนนี้ — เดี๋ยวเก็บตอนใช้จริง */ }
      }));
    } catch (e) { /* เก็บไม่ได้ก็ไม่เป็นไร ห้ามทำให้ install ล้ม */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, ASSET_CACHE];
    const names = await caches.keys();
    await Promise.all(names.map(n => keep.includes(n) ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

/* __swReset() ในแอปส่งข้อความ "clearShell" มาที่นี่
   ล้าง cache อย่างเดียว ไม่ถอน SW ออก — รีเฟรชรอบหน้าจะไปเอาของใหม่จากเน็ตตรงๆ
   แล้ว SW ก็ยังทำงานเก็บของให้ต่อเหมือนเดิม */
self.addEventListener("message", event => {
  if (event.data !== "clearShell") return;
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  })());
});

const isAsset = url => ASSET_HOSTS.includes(url.hostname);
const isForbidden = url => NEVER_TOUCH.some(k => url.href.includes(k));

self.addEventListener("fetch", event => {
  const req = event.request;

  // แตะเฉพาะ GET — POST/PUT ต้องผ่านตรงๆ
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isForbidden(url)) return;

  const sameOrigin = url.origin === self.location.origin;

  // ── ตัวแอปและไฟล์ในโฟลเดอร์เดียวกัน: เสิร์ฟของเก่าทันที + ดึงใหม่เบื้องหลัง ──
  if (sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });

      // ดึงตัวใหม่มาเก็บทับ — .catch กันไม่ให้ reject หลุดออกไป
      const fresh = fetch(req).then(res => {
        if (res && res.ok && res.type === "basic") {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);

      if (cached) {
        event.waitUntil(fresh);   // ให้ SW อยู่ต่อจนดึงเสร็จ
        return cached;            // เสิร์ฟจากเครื่องทันที ไม่รอเน็ต
      }

      const res = await fresh;
      if (res) return res;

      // ไม่มีทั้งเน็ตทั้งของเก่า
      if (req.mode === "navigate") {
        return new Response(
          "<meta charset='utf-8'><div style='padding:40px;text-align:center;font-family:sans-serif'>" +
          "<h3>เปิดแอปไม่ได้</h3><p>ยังไม่เคยเปิดตอนมีเน็ต จึงไม่มีตัวแอปเก็บไว้ในเครื่อง</p></div>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return Response.error();
    })());
    return;
  }

  // ── ไฟล์ CDN: ของที่เก็บไว้ก่อน ──
  if (isAsset(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // opaque (status 0) เก็บได้ ใช้ซ้ำได้ปกติ — สคริปต์ CDN เป็นแบบนี้
        if (res && (res.ok || res.type === "opaque")) {
          const c = await caches.open(ASSET_CACHE);
          c.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const alt = await caches.match(req.url.split("?")[0], { ignoreVary: true });
        if (alt) return alt;
        throw e;
      }
    })());
    return;
  }

  // นอกเหนือจากนี้ ไม่ respondWith = ปล่อยผ่านตามปกติ
});
