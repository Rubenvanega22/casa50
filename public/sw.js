// Casa 50 — Service Worker
// Estrategias:
//   - HTML/navegación: network-first con timeout 3s -> fallback caché
//   - Íconos PNG, manifest, CDN: stale-while-revalidate
//   - /api/, Supabase, métodos no-GET: passthrough (nunca cachear)
//
// Subir versión ('casa50-v2', etc.) en cambios que requieran invalidar caché.

const CACHE = 'casa50-v1';
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
