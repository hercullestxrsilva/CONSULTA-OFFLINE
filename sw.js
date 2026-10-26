/* Service worker: guarda o app no celular para abrir sem internet.
   Ao mudar qualquer arquivo do app, aumente VERSAO para os celulares baixarem a nova versão. */
const VERSAO = 'consulta-precos-v2';
const ARQUIVOS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'vendor/zxing-reader.js',
  'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const nome of await caches.keys()) if (nome !== VERSAO) await caches.delete(nome);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'atualizar') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // dados publicados junto do app (opcional): sempre da rede, o app guarda no IndexedDB
  if (url.pathname.endsWith('/produtos.json')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSAO);
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || fetch(req);
    }
    const achado = await cache.match(req, { ignoreSearch: true });
    if (achado) return achado;
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
