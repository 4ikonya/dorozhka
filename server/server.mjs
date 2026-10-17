#!/usr/bin/env node
// «Дорожка» for one coach: serves the app, keeps data in SQLite, sends Telegram reminders.
// No dependencies, Node 22.13+.   node server/server.mjs   →   http://localhost:4318
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TZ, applyAttendance, attendanceView, dueMessages, dayText, forgetPhotos, nextText, photoForms, receiptsReport, receiptsSoFar, startText, textChunks, wallNow } from '../shared/schedule.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4318;
const HOST = process.env.HOST || '127.0.0.1';
const TG_API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const DB_FILE = process.env.DB_FILE || path.join(root, 'data', 'dorozhka.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state    (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS backups  (day TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS telegram (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT, bot_name TEXT, chat_id INTEGER, update_offset INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sent     (key TEXT PRIMARY KEY, at TEXT NOT NULL);
  INSERT OR IGNORE INTO telegram (id) VALUES (1);
`);

/* ---------- data ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function readState() {
  const row = db.prepare('SELECT json, version FROM state WHERE id = 1').get();
  return row ? { version: row.version, state: JSON.parse(row.json) } : { version: 0, state: null };
}
function writeState(state, expectedVersion) {
  const cur = db.prepare('SELECT json, version FROM state WHERE id = 1').get();
  const curVersion = cur ? cur.version : 0;
  if (expectedVersion !== curVersion) return { conflict: true, ...readState() };
  const today = dayKey(new Date());
  if (cur) db.prepare('INSERT OR IGNORE INTO backups (day, json) VALUES (?, ?)').run(today, cur.json);
  const version = curVersion + 1;
  db.prepare(`INSERT INTO state (id, json, version, updated_at) VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at`)
    .run(JSON.stringify(state), version, new Date().toISOString());
  db.prepare("DELETE FROM backups WHERE day < date('now', '-30 days')").run();
  return { version };
}
const tgRow = () => db.prepare('SELECT token, bot_name, chat_id, update_offset FROM telegram WHERE id = 1').get();
const tgStatus = () => { const t = tgRow(); return { connected: !!t.token, chatLinked: !!t.chat_id, botName: t.bot_name || '' }; };

/* ---------- schedule: shared with the cloud function ---------- */
// The coach's time zone from the app settings, not the laptop's own.
const wnow = (S = readState().state) => wallNow(new Date(), S?.settings?.tz || DEFAULT_TZ);

/* ---------- telegram ---------- */
async function tg(method, body, token = tgRow().token) {
  if (!token) throw new Error('Бот не подключён');
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
  if (!json.ok) throw new Error(json.description || 'Ошибка Telegram');
  return json.result;
}
const send = (text) => tg('sendMessage', { chat_id: tgRow().chat_id, text });
const wasSent = (key) => !!db.prepare('SELECT 1 FROM sent WHERE key = ?').get(key);
const markSent = (key) => db.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').run(key, new Date().toISOString());
const unmarkSent = (key) => db.prepare('DELETE FROM sent WHERE key = ?').run(key);

// Long text in parts, then receipt photos as albums of up to 10.
async function sendReport(m) {
  const { token, chat_id } = tgRow();
  for (const part of textChunks(m.text)) await tg('sendMessage', { chat_id, text: part });
  const sent = [];
  for (const { fd, ids } of photoForms(chat_id, m.photos || [])) {
    const json = await (await fetch(`${TG_API}/bot${token}/sendMediaGroup`, { method: 'POST', body: fd })).json().catch(() => ({ ok: false }));
    if (json.ok) sent.push(...ids); else console.error(`[telegram] receipts album: ${json.description || 'ошибка'}`);
  }
  return sent;
}
// After the monthly report the photos are in the chat: drop them from the data (the payment stays).
function dropSentPhotos(ids, day) {
  const { version, state } = readState();
  if (state && forgetPhotos(state, ids, day)) writeState(state, version);
}
async function deliver(key, text, extra = {}) {
  markSent(key);
  try { await tg('sendMessage', { chat_id: tgRow().chat_id, text, ...extra }); console.log(`[telegram] ${key}`); }
  catch (e) { unmarkSent(key); console.error(`[telegram] ${key}: ${e.message}`); }
}
async function tick() {
  const t = tgRow();
  if (!t.token || !t.chat_id) return;
  const { state: S } = readState();
  if (!S) return;
  for (const m of dueMessages(S, wnow(S), wasSent, { receipts: true })) {
    if (!m.photos) { await deliver(m.key, m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {}); continue; }
    markSent(m.key);
    try { const ids = await sendReport(m); if (m.purge) dropSentPhotos(ids, m.key.slice(9) + '-20'); console.log(`[telegram] ${m.key}`); } catch (e) { unmarkSent(m.key); console.error(`[telegram] ${m.key}: ${e.message}`); }
  }
}
// A press on "был / не предупредил / предупредил" under an attendance message.
async function onButton(q) {
  const cur = tgRow();
  if (Number(cur.chat_id) !== q.message?.chat?.id) return tg('answerCallbackQuery', { callback_query_id: q.id });
  const { version, state: S } = readState();
  const s = S && applyAttendance(S, q.data);
  if (!s) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Это занятие уже удалено' });
  writeState(S, version);
  const view = attendanceView(S, s);
  await tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: view.text, reply_markup: view.reply_markup }).catch(() => {});
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Сохранено' });
}
async function pollLoop() {
  for (;;) {
    const t = tgRow();
    if (!t.token) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    try {
      const updates = await tg('getUpdates', { offset: t.update_offset, timeout: 25 }, t.token);
      for (const u of updates) {
        db.prepare('UPDATE telegram SET update_offset = ? WHERE id = 1').run(u.update_id + 1);
        if (u.callback_query) { await onButton(u.callback_query); continue; }
        const m = u.message;
        if (!m?.text) continue;
        const cur = tgRow();
        if (!cur.chat_id && m.text.startsWith('/start')) {
          db.prepare('UPDATE telegram SET chat_id = ? WHERE id = 1').run(m.chat.id);
          await send(startText(readState().state, { receipts: true }));
          await tick();
        } else if (Number(cur.chat_id) === m.chat.id) {
          const { state: S } = readState();
          if (!S) continue;
          if (m.text.startsWith('/today')) await send(dayText(S, wnow()));
          else if (m.text.startsWith('/next')) await send(nextText(S, wnow()));
          else if (m.text.startsWith('/receipts')) { const { from, to } = receiptsSoFar(wnow(S)); await sendReport(receiptsReport(S, from, to)); }
        }
      }
    } catch (e) {
      console.error(`[telegram] ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* ---------- token file: paste the token into telegram-token.txt and save ---------- */
const TOKEN_FILE = path.join(root, 'telegram-token.txt');
const TOKEN_HINT = '# Вставьте токен от @BotFather на пустую строку ниже и сохраните файл (Cmd+S).\n# Сервис подхватит его сам за несколько секунд, а эту строку с токеном сотрёт.\n\n';
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, TOKEN_HINT);
let tokenFileBusy = false;
async function checkTokenFile() {
  if (tokenFileBusy) return;
  tokenFileBusy = true;
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!token || token === tgRow().token) return;
    if (!/^\d+:[\w-]{20,}$/.test(token)) {
      fs.writeFileSync(TOKEN_FILE, `${TOKEN_HINT}# Не похоже на токен от @BotFather. Он выглядит так: 123456789:AAH… — вставьте его ниже.\n`);
      return;
    }
    const me = await tg('getMe', {}, token);
    db.prepare('UPDATE telegram SET token = ?, bot_name = ?, chat_id = NULL, update_offset = 0 WHERE id = 1').run(token, me.username);
    fs.writeFileSync(TOKEN_FILE, `# Готово: бот @${me.username} подключён, токен сохранён в базе.\n# Откройте https://t.me/${me.username} и нажмите Start.\n`);
    console.log(`[telegram] подключён @${me.username}`);
  } catch (e) {
    fs.writeFileSync(TOKEN_FILE, `${TOKEN_HINT}# Telegram не принял токен: ${e.message}. Проверьте, что скопировали его целиком.\n`);
  } finally {
    tokenFileBusy = false;
  }
}
setInterval(checkTokenFile, 3000);

/* ---------- http ---------- */
function page() {
  const body = fs.readFileSync(path.join(root, 'dorozhka.html'), 'utf8');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
}
function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Неверный JSON')); } });
    req.on('error', reject);
  });
}
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return json(res, 200, readState());
      if (req.method === 'PUT') {
        const { version, state } = await readBody(req);
        if (!state || !Array.isArray(state.sessions) || !Array.isArray(state.clients)) return json(res, 400, { error: 'Неверные данные' });
        const r = writeState(state, version);
        return r.conflict ? json(res, 409, { error: 'Данные изменились', version: r.version, state: r.state }) : json(res, 200, r);
      }
    }
    if (url.pathname === '/api/telegram') {
      if (req.method === 'GET') return json(res, 200, tgStatus());
      if (req.method === 'POST') {
        const { token } = await readBody(req);
        if (!/^\d+:[\w-]{20,}$/.test(String(token || '').trim())) return json(res, 400, { error: 'Это не похоже на токен от @BotFather' });
        const me = await tg('getMe', {}, token.trim());
        db.prepare('UPDATE telegram SET token = ?, bot_name = ?, chat_id = NULL, update_offset = 0 WHERE id = 1').run(token.trim(), me.username);
        return json(res, 200, tgStatus());
      }
      if (req.method === 'DELETE') {
        db.prepare('UPDATE telegram SET token = NULL, bot_name = NULL, chat_id = NULL, update_offset = 0 WHERE id = 1').run();
        return json(res, 200, tgStatus());
      }
    }
    if (url.pathname === '/api/telegram/test' && req.method === 'POST') {
      if (!tgRow().chat_id) return json(res, 400, { error: 'Сначала нажмите Start в чате с ботом' });
      const { state: S } = readState();
      await send(`Проверка связи: напоминания будут приходить сюда.\n\n${S ? dayText(S, wnow()) : ''}`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, ...tgStatus(), version: readState().version });
    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Дорожка работает: http://localhost:${PORT}`);
  console.log(`База: ${DB_FILE}`);
});
setInterval(() => tick().catch((e) => console.error(e.message)), 30000);
setTimeout(() => tick().catch((e) => console.error(e.message)), 2000);
pollLoop();
