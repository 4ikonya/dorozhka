#!/usr/bin/env node
// Builds cloud/web (the site Vercel serves) from dorozhka.html, with the Supabase project baked in,
// and copies the shared reminder logic into the Supabase function.
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
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>',
  `<script>window.DOROZHKA_CLOUD=${JSON.stringify(cloud)}</script>`,
].join('');
fs.writeFileSync(path.join(web, 'index.html'), `<!doctype html><html lang="ru"><head>${head}</head><body>${body}</body></html>`);

fs.writeFileSync(path.join(web, 'manifest.webmanifest'), JSON.stringify({
  name: 'Дорожка — журнал тренера',
  short_name: 'Дорожка',
  lang: 'ru',
  start_url: '/',
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
  headers: [{ source: '/(.*)', headers: [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
  ] }],
}, null, 2));

console.log(`Готово: ${path.relative(root, web)}/ (Supabase: ${cloud.url})`);
