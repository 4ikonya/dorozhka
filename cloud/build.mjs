#!/usr/bin/env node
// Builds cloud/web (the site Vercel serves) and copies the shared reminder logic into the Supabase function:
//   /       the landing page (landing.html; until it exists, a redirect to /app)
//   /app    the journal, with the Supabase project baked in
//   /demo   the same journal on demo data in the browser, no account
//   node cloud/build.mjs        (reads cloud/config.json: { "supabaseUrl": "...", "anonKey": "..." })
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const web = path.join(here, 'web');
const cfgFile = path.join(here, 'config.json');

const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
if (!cfg.supabaseUrl || !cfg.anonKey) {
  console.warn('cloud/config.json не заполнен — собираю с пустыми адресами (только для проверки вёрстки).');
}
const cloud = { url: cfg.supabaseUrl || 'https://PROJECT_REF.supabase.co', anonKey: cfg.anonKey || 'ANON_KEY' };

fs.mkdirSync(web, { recursive: true });
fs.mkdirSync(path.join(here, 'supabase', 'functions', '_shared'), { recursive: true });
fs.copyFileSync(path.join(root, 'shared', 'schedule.mjs'), path.join(here, 'supabase', 'functions', '_shared', 'schedule.mjs'));

const body = fs.readFileSync(path.join(root, 'dorozhka.html'), 'utf8');
const head = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="theme-color" content="#0A6383">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Дорожка">',
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="icon" href="/icon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/icon.svg">',
  '<style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>',
  // Pinned with a hash: a changed CDN file is refused instead of running with the coach's session.
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js" integrity="sha384-0w2KAL2YHP6wKOkUDzkCDGgVvfmHnj02DHeQ6XcHOgTfFsGyonKOpShMH1x6nk9o" crossorigin="anonymous"></script>',
  `<script>window.DOROZHKA_CLOUD=${JSON.stringify(cloud)}</script>`,
].join('');
const page = (h) => `<!doctype html><html lang="ru"><head>${h}</head><body>${body}</body></html>`;
for (const dir of ['app', 'demo']) fs.mkdirSync(path.join(web, dir), { recursive: true });
fs.writeFileSync(path.join(web, 'app', 'index.html'), page(head));
// The demo is the plain app: without DOROZHKA_CLOUD it runs on demo data kept in the browser.
const demoHead = head.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^]*$/, '');
fs.writeFileSync(path.join(web, 'demo', 'index.html'), page(demoHead + '<meta name="robots" content="noindex">'));
// Landing: screenshots from docs/ are served from /img/.
const landing = path.join(root, 'landing.html');
fs.mkdirSync(path.join(web, 'img'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'docs', 'screenshots'))) fs.copyFileSync(path.join(root, 'docs', 'screenshots', f), path.join(web, 'img', f));
fs.writeFileSync(path.join(web, 'index.html'), fs.existsSync(landing)
  ? fs.readFileSync(landing, 'utf8').replaceAll('/docs/screenshots/', '/img/')
  : '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/app"><title>Дорожка</title><a href="/app">Дорожка</a>');

fs.writeFileSync(path.join(web, 'manifest.webmanifest'), JSON.stringify({
  name: 'Дорожка — журнал тренера',
  short_name: 'Дорожка',
  lang: 'ru',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  background_color: '#EDF3F5',
  theme_color: '#0A6383',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
}, null, 2));

// Lane rope across a pool-blue tile.
fs.writeFileSync(path.join(web, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#0A6383"/>
<g stroke-width="26" stroke-linecap="round" fill="none">
<path d="M96 200c40-28 80-28 120 0s80 28 120 0 80-28 100-14" stroke="#EDF3F5"/>
<path d="M96 312c40-28 80-28 120 0s80 28 120 0 80-28 100-14" stroke="#EDF3F5" opacity=".55"/>
</g>
<g fill="#DE4A30"><circle cx="128" cy="408" r="22"/><circle cx="208" cy="408" r="22"/><circle cx="288" cy="408" r="22"/><circle cx="368" cy="408" r="22"/></g>
</svg>`);

fs.writeFileSync(path.join(web, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  rewrites: [{ source: '/app', destination: '/app/index.html' }, { source: '/demo', destination: '/demo/index.html' }],
  headers: [{ source: '/(.*)', headers: [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ] }],
}, null, 2));

console.log(`Готово: ${path.relative(root, web)}/ (Supabase: ${cloud.url})`);
