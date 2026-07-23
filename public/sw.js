// Casa 50 — Service Worker
// Estrategias:
//   - HTML/navegación: network-first con timeout 3s -> fallback caché
//   - Íconos PNG, manifest, CDN: stale-while-revalidate
//   - /api/, Supabase, métodos no-GET: passthrough (nunca cachear)
//
// Subir versión ('casa50-v2', etc.) en cambios que requieran invalidar caché.

const CACHE = 'casa50-v2';   // ↑ fuerza update del SW para instalar los handlers de push (Sub-etapa 4)
const HTML_TIMEOUT_MS = 3000;

const PRECACHE = [
  '/manifest.json',
  '/favicon-32.png',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return c.addAll(PRECACHE).catch(function(){});
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== CACHE && k.indexOf('casa50-') === 0) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function shouldBypass(req, url){
  if(req.method !== 'GET') return true;
  if(url.pathname.indexOf('/api') === 0) return true;
  if(url.hostname.indexOf('supabase.co') >= 0) return true;
  return false;
}

function isHTML(req, url){
  if(req.mode === 'navigate') return true;
  if(url.pathname === '/' || url.pathname === '/index.html') return true;
  var accept = req.headers.get('accept') || '';
  return accept.indexOf('text/html') >= 0;
}

function isStaticAsset(url){
  if(/\.(png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(url.pathname)) return true;
  if(url.pathname === '/manifest.json') return true;
  if(url.hostname.indexOf('cdn.jsdelivr.net') >= 0) return true;
  return false;
}

function networkFirstWithTimeout(req){
  return new Promise(function(resolve){
    var settled = false;
    var timer = setTimeout(function(){
      if(settled) return;
      caches.match(req).then(function(cached){
        if(settled || !cached) return;
        settled = true;
        resolve(cached);
      });
    }, HTML_TIMEOUT_MS);

    fetch(req).then(function(res){
      if(res && res.ok){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy).catch(function(){}); });
      }
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    }).catch(function(){
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      caches.match(req).then(function(cached){
        resolve(cached || new Response('Offline', {status: 503, statusText: 'Offline'}));
      });
    });
  });
}

function staleWhileRevalidate(req){
  return caches.open(CACHE).then(function(c){
    return c.match(req).then(function(cached){
      var networkPromise = fetch(req).then(function(res){
        if(res && (res.ok || res.type === 'opaque')){
          try { c.put(req, res.clone()); } catch(_){}
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || networkPromise;
    });
  });
}

self.addEventListener('fetch', function(e){
  var url;
  try { url = new URL(e.request.url); } catch(_){ return; }

  if(shouldBypass(e.request, url)) return;

  if(isHTML(e.request, url)){
    e.respondWith(networkFirstWithTimeout(e.request));
    return;
  }

  if(isStaticAsset(url)){
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }
});

// ===== Web Push (Sub-etapa 4) — recibir avisos del colaborador con el POS cerrado =====
// Espejo de los handlers del fork colaborador (ya probados). El envío lo firma el fork
// (tanda 2) con la misma llave VAPID; aquí solo se muestra y se enfoca la app al tocar.
self.addEventListener('push', function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  var opts = {
    body: data.body || '', tag: data.tag || 'casa50-admin',
    renotify: true, requireInteraction: true, silent: false,
    vibrate: [200,100,200,100,200], icon: '/icon-192.png',
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(data.title || 'Casa 50', opts));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
    for (var i=0;i<list.length;i++){ var c=list[i];
      if (c.url.indexOf(self.location.origin)===0){ c.focus(); if('navigate' in c){ try{ c.navigate(url); }catch(er){} } return; } }
    return self.clients.openWindow(url);
  }));
});
