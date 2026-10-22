// Telegram for «Дорожка» in the cloud. One function, four kinds of callers:
//   POST /telegram/tick            — pg_cron every minute (x-cron-secret, checked by the database): sends due reminders
//   POST /telegram/cleanup         — pg_cron daily (same secret): receipt photos older than a year are deleted
//   POST /telegram/hook            — webhook of the shared bot (secret in X-Telegram-Bot-Api-Secret-Token; the old /hook/<secret> still works): linking a chat to a journal, attendance buttons, /today, /next, /receipts (owner only)
//   POST /telegram/status|test|link|unlink — the signed-in coach from the app (coaches sign in with Google)
// Every coach has their own account and data; the bot tells them apart by their Telegram chat.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { applyAttendance, attendanceView, dayKey, dayText, dueMessages, expirePhotos, forgetPhotos, loginPlace, nextText, photoForms, receiptsReport, receiptsSoFar, startText, textChunks, wallNow } from '../_shared/schedule.mjs';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DEFAULT_TZ = 'Asia/Almaty';

const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'content-type': 'application/json' } });

// The shared bot (public.bot) and a coach's link to it: their account and their chat with the bot.
type Bot = { token: string; bot_name: string; hook_secret: string };
type Coach = { owner: string; chat_id: number | null; receipts_report?: boolean; blocked_at?: string | null };

let botCache: Bot | null = null;
async function getBot(): Promise<Bot> {
  if (botCache) return botCache;
  const { data } = await admin.from('bot').select('token, bot_name, hook_secret').maybeSingle();
  if (!data) throw new Error('Бот сервиса не настроен');
  return (botCache = data as Bot);
}
const coachByChat = async (chatId: number) =>
  ((await admin.from('telegram_links').select('owner, chat_id, receipts_report, blocked_at').eq('chat_id', chatId).maybeSingle()).data as Coach | null);

async function tg(token: string, method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
  if (!out.ok) throw Object.assign(new Error(out.description || 'Ошибка Telegram'), { code: out.error_code });
  return out.result;
}
// 403 from Telegram: the coach blocked the bot (or deleted the account). Retrying every minute won't help.
const isBlocked = (e: unknown) => (e as { code?: number }).code === 403;
// Receipt photos live in a private Storage bucket, under <owner>/<payment id>.<ext>.
const RECEIPTS = 'receipts';
type Photo = { id: string; img?: string; path?: string; blob?: Blob; caption: string };
// Storage photos are downloaded first; one that can't be read is logged and left out of the album.
async function withBlobs(photos: Photo[]) {
  const out: Photo[] = [];
  for (const ph of photos) {
    if (!ph.path) { out.push(ph); continue; }
    const { data, error } = await admin.storage.from(RECEIPTS).download(ph.path);
    if (data) out.push({ ...ph, blob: data }); else console.error(`telegram receipt ${ph.path}: ${error?.message}`);
  }
  return out;
}
// Long text in parts, then receipt photos as albums of up to 10. A failed album is logged, the rest still go out.
// Returns the photos that reached the chat.
async function sendReport(token: string, chatId: number, m: { text: string; photos?: Photo[] }) {
  for (const part of textChunks(m.text)) await tg(token, 'sendMessage', { chat_id: chatId, text: part });
  const photos = await withBlobs(m.photos || []), sent: Photo[] = [];
  for (const { fd, ids } of photoForms(chatId, photos)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
    if (out.ok) sent.push(...photos.filter((ph) => ids.includes(ph.id))); else console.error(`telegram receipts album: ${out.description}`);
  }
  return sent;
}
// Every write goes through save_state_for, like the app's save_state: version check, shape and size check, daily backup.
// Returns false when someone saved meanwhile (the caller reads again).
async function saveState(owner: string, version: number, data: unknown) {
  const { data: r, error } = await admin.rpc('save_state_for', { p_owner: owner, expected: version, new_data: data });
  if (error) throw new Error(error.message);
  return !r?.[0]?.is_conflict;
}
// Drops photos that are now in the chat: from the journal (retried if the app saved meanwhile), then from Storage.
async function dropSentPhotos(owner: string, sent: Photo[], day: string) {
  const ids = sent.map((ph) => ph.id), paths = sent.flatMap((ph) => (ph.path ? [ph.path] : []));
  for (let i = 0; i < 5 && ids.length; i++) {
    const { data: row } = await admin.from('app_state').select('data, version').eq('owner', owner).maybeSingle();
    if (!row?.data || !forgetPhotos(row.data, ids, day)) return;
    if (await saveState(owner, row.version, row.data)) return removePhotos(paths);
  }
  console.error('telegram receipts: photos sent but not removed (state kept changing)');
}
async function removePhotos(paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from(RECEIPTS).remove(paths.slice(i, i + 100));
    if (error) console.error(`telegram receipts remove: ${error.message}`);
  }
}
// Daily (pg_cron → /cleanup): receipt photos are kept a year after the payment, then dropped from every journal and Storage.
async function cleanup() {
  const { data: rows, error } = await admin.from('app_state').select('owner');
  if (error) throw new Error(error.message);
  let photos = 0, failed = 0;
  for (const { owner } of rows ?? []) {
    try {
      for (let i = 0; i < 5; i++) {
        const { data: row } = await admin.from('app_state').select('data, version').eq('owner', owner).maybeSingle();
        if (!row?.data) break;
        const { n, paths } = expirePhotos(row.data, dayKey(nowFor(row.data)));
        if (!n) break;
        if (await saveState(owner, row.version, row.data)) { await removePhotos(paths); photos += n; break; }
      }
    } catch (e) { failed++; console.error(`telegram cleanup ${String(owner).slice(0, 8)}: ${(e as Error).message}`); }
  }
  return { ok: true, photos, failed };
}
async function stateOf(owner: string) {
  const { data } = await admin.from('app_state').select('data').eq('owner', owner).maybeSingle();
  return data?.data ?? null;
}
const nowFor = (S: any) => wallNow(new Date(), S?.settings?.tz || DEFAULT_TZ);
const status = (l: Coach | null, bot: Bot) => ({ connected: true, shared: true, chatLinked: !!l?.chat_id, botName: bot.bot_name, receipts: !!l?.receipts_report, blocked: !!l?.blocked_at });

async function tick() {
  const bot = await getBot();
  // A chat that blocked the bot is skipped until the coach writes to the bot again (see webhook).
  const { data: links } = await admin.from('telegram_links').select('owner, chat_id, receipts_report').not('chat_id', 'is', null).is('blocked_at', null);
  let sent = 0, failed = 0;
  // One coach's broken data or a failed query must not stop the reminders of everybody else.
  for (const l of (links ?? []) as Coach[]) {
    try { sent += await tickCoach(bot, l); }
    catch (e) { failed++; console.error(`telegram tick ${l.owner.slice(0, 8)}: ${(e as Error).message}`); }
  }
  return { ok: true, sent, failed };
}
async function tickCoach(bot: Bot, l: Coach) {
  let sent = 0;
  const S = await stateOf(l.owner);
  if (!S) return 0;
  // Read only the keys this tick asks about: a dry run collects them, then one query says which were sent.
  const now = nowFor(S), opts = { receipts: !!l.receipts_report }, asked = new Set<string>();
  dueMessages(S, now, (k: string) => { asked.add(k); return false; }, opts);
  if (!asked.size) return 0;
  const { data: rows } = await admin.from('sent_reminders').select('key').eq('owner', l.owner).in('key', [...asked]);
  const done = new Set((rows ?? []).map((r) => r.key));
  for (const m of dueMessages(S, now, (k: string) => done.has(k), opts)) {
    // Claim the key first so two overlapping ticks never send the same message.
    const { error } = await admin.from('sent_reminders').insert({ owner: l.owner, key: m.key });
    if (error) continue;
    try {
      if (m.photos) {
        const sentPhotos = await sendReport(bot.token, l.chat_id as number, m);
        if (m.purge) await dropSentPhotos(l.owner, sentPhotos, m.key.slice(9) + '-20');
      }
      else await tg(bot.token, 'sendMessage', { chat_id: l.chat_id, text: m.text, ...(m.reply_markup ? { reply_markup: m.reply_markup } : {}) });
      sent++;
    } catch (e) {
      await admin.from('sent_reminders').delete().eq('owner', l.owner).eq('key', m.key);
      console.error(`telegram ${m.key}: ${(e as Error).message}`);
      if (isBlocked(e)) { await admin.from('telegram_links').update({ blocked_at: new Date().toISOString() }).eq('owner', l.owner); break; }
    }
  }
  return sent;
}

/* ---------- linking a Telegram chat to a journal ---------- */
// Coaches sign in with Google. In the settings the app asks for a one-time link request (/link), opens the bot
// with it, and the coach confirms in the bot that this chat belongs to their journal.
const LINK_TTL_MIN = 10;
const fresh = () => new Date(Date.now() - LINK_TTL_MIN * 60_000).toISOString();
// Accounts the bot created before the Google login (no real address, never mailed). Such a journal moves
// into the coach's Google account when they link the same chat from it (merge_into_legacy).
const isLegacy = (email?: string | null) => /^tg-?\d+@users\.dorozhka\.example$/.test(email ?? '');
const emailOf = async (owner: string) => (await admin.auth.admin.getUserById(owner)).data?.user?.email ?? null;
// A journal with no clients, sessions or payments: only such a one may be replaced by the old journal.
const isEmpty = (S: any) => !S || !((S.clients?.length ?? 0) + (S.sessions?.length ?? 0) + (S.payments?.length ?? 0));

// The address the bot shows with a link request. Supabase does not document a trusted client-IP header.
// The platform sits behind Cloudflare, which overwrites cf-connecting-ip with the real address; x-forwarded-for keeps
// whatever the caller sent in front, and the proxy appends the real address last, so never trust its first entry.
const callerIp = (req: Request) =>
  req.headers.get('cf-connecting-ip')?.trim() || (req.headers.get('x-forwarded-for') ?? '').split(',').pop()!.trim() || 'unknown';

async function linkStart(req: Request, owner: string) {
  const bot = await getBot();
  await admin.from('link_requests').delete().lt('created_at', new Date(Date.now() - 864e5).toISOString());
  const { count } = await admin.from('link_requests').select('nonce', { count: 'exact', head: true }).eq('owner', owner).gt('created_at', fresh());
  if ((count ?? 0) >= 6) return json({ error: 'Слишком много попыток. Подождите 10 минут.' }, 429);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 400);
  const { error } = await admin.from('link_requests').insert({ nonce, owner, ip: callerIp(req), ua });
  if (error) throw new Error(error.message);
  return json({ nonce, bot: bot.bot_name, ttl: LINK_TTL_MIN * 60 });
}
// The request is checked again when the button is pressed: it may have been used or have expired meanwhile.
const openRequest = async (nonce: string) =>
  (await admin.from('link_requests').select('nonce, owner, ip, ua, created_at').eq('nonce', nonce).is('used_at', null).gt('created_at', fresh()).maybeSingle()).data;
const claim = async (nonce: string) =>
  !!(await admin.from('link_requests').update({ used_at: new Date().toISOString() })
    .eq('nonce', nonce).is('used_at', null).gt('created_at', fresh()).select('nonce')).data?.length;
const STALE = 'Ссылка устарела. Нажмите «Подключить Telegram» в настройках журнала ещё раз.';
const WARN = 'Нажимайте, только если вы сами сейчас подключаете Telegram в своём журнале и это ваша почта. Если ссылку прислал кто-то другой — нажмите «Нет».';
const DONE = 'Сюда будут приходить напоминания о занятиях, сводка дня в 7:00 и кнопки отметки посещения. Клиентам бот ничего не пишет.';

// /start link_<nonce>: the bot says which journal asks for this chat and what pressing «Да» will do.
async function linkAsk(bot: Bot, chatId: number, nonce: string, coach: Coach | null) {
  const r = await openRequest(nonce);
  if (!r) return tg(bot.token, 'sendMessage', { chat_id: chatId, text: STALE });
  const email = await emailOf(r.owner);
  if (!email) return tg(bot.token, 'sendMessage', { chat_id: chatId, text: STALE });
  const say = (text: string, act?: string, yes?: string) => tg(bot.token, 'sendMessage', {
    chat_id: chatId, text,
    ...(act ? { reply_markup: { inline_keyboard: [[{ text: yes, callback_data: `${act}|${nonce}|y` }, { text: 'Нет', callback_data: `${act}|${nonce}|n` }]] } } : {}),
  });
  const place = `Запрос: ${loginPlace(r)}`;
  if (coach?.owner === r.owner) return say(`Этот чат уже подключён к журналу ${email}.`);
  if (coach) {
    const old = await emailOf(coach.owner);
    if (!isLegacy(old)) return say(`Этот Telegram уже подключён к другому журналу (${old}). Сначала отключите его в настройках того журнала.`);
    if (!isEmpty(await stateOf(r.owner))) {
      return say(`У этого Telegram есть журнал, в который вы входили через бота. Перенести его можно только в пустой журнал, а в ${email} уже есть клиенты или занятия. Войдите через Google с другой почтой или напишите в поддержку.`);
    }
    return say(`Перенос журнала\n\nЭтот Telegram связан с журналом, в который вы входили через бота. Перенести его в аккаунт Google ${email}?\n\nКлиенты, расписание, оплаты и чеки сохранятся, а входить вы будете через Google. Пустой журнал этого аккаунта удалится.\n\n${place}\n${WARN}`, 'move', 'Да, перенести');
  }
  return say(`Подключение Telegram\n\nПодключить этот чат к журналу ${email}?\n\n${place}\n${WARN}`, 'link', 'Да, подключить');
}

async function linkAnswer(bot: Bot, q: any, coach: Coach | null) {
  const [act, nonce, ans] = String(q.data).split('|');
  const chatId = q.message.chat.id;
  let text = 'Отменено. Если ссылку прислал кто-то другой — ничего делать не нужно.';
  const r = ans === 'y' ? await openRequest(nonce) : null;
  if (ans !== 'y') await admin.from('link_requests').delete().eq('nonce', nonce).is('used_at', null);
  else if (!r || !(await claim(nonce))) text = STALE;
  else if (act === 'link') {
    if (coach && coach.owner !== r.owner) text = 'Этот чат уже подключён к другому журналу.';
    else {
      // A journal moves to another chat: the row keeps its other settings (receipts_report).
      const { error } = await admin.from('telegram_links').upsert({ owner: r.owner, chat_id: chatId, blocked_at: null }, { onConflict: 'owner' });
      text = error ? `Не получилось подключить: ${error.message}` : `Готово, Telegram подключён — вернитесь в браузер.\n\n${DONE}`;
    }
  } else if (act === 'move') {
    if (!coach || !isLegacy(await emailOf(coach.owner)) || !isEmpty(await stateOf(r.owner))) text = 'Перенести журнал не получилось: данные изменились. Нажмите «Подключить Telegram» ещё раз.';
    else {
      const { error } = await admin.rpc('merge_into_legacy', { p_old: coach.owner, p_new: r.owner });
      text = error
        ? `Перенести журнал не получилось: ${error.message}`
        : `Журнал перенесён в аккаунт ${await emailOf(coach.owner)}. Вернитесь в браузер и войдите через Google ещё раз.\n\n${DONE}`;
      if (error) console.error(`telegram merge: ${error.message}`);
    }
  }
  await tg(bot.token, 'editMessageText', { chat_id: chatId, message_id: q.message.message_id, text }).catch(() => {});
  await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
}

// Buttons from before the Google login (sign in through the bot, «Это не я — завершить все сеансы»).
async function oldButton(bot: Bot, q: any) {
  await tg(bot.token, 'answerCallbackQuery', {
    callback_query_id: q.id, show_alert: true,
    text: 'Кнопка устарела: вход теперь через Google. Выйти на всех устройствах можно в настройках журнала.',
  }).catch(() => {});
}

const WELCOME = 'Это бот «Дорожки» — журнала тренера по плаванию.\n\nЧтобы получать здесь напоминания, откройте dorozhka.vercel.app, войдите через Google и в разделе «Ещё» нажмите «Подключить Telegram».\n\nВходили раньше через этого бота? Сделайте то же самое: бот предложит перенести старый журнал в ваш аккаунт Google.';

async function webhook(secret: string, update: any) {
  const bot = await getBot();
  if (!secret || secret !== bot.hook_secret) return;
  const q = update?.callback_query, m = update?.message;
  const chat = q?.message?.chat ?? m?.chat;
  if (!chat || chat.type !== 'private') return; // only one-to-one chats with a coach
  const coach = await coachByChat(chat.id);
  // The coach writes or presses a button again after blocking the bot: reminders resume.
  if (coach?.blocked_at) await admin.from('telegram_links').update({ blocked_at: null }).eq('owner', coach.owner);
  if (q) {
    if (/^(link|move)\|/.test(String(q.data))) return linkAnswer(bot, q, coach);
    if (/^(login|reg|sout)\|/.test(String(q.data))) return oldButton(bot, q);
    if (!coach) return tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    // Bump the version so an open app sees the change and reloads instead of overwriting it.
    const { data: row } = await admin.from('app_state').select('data, version').eq('owner', coach.owner).maybeSingle();
    const S = row?.data;
    const s = S && applyAttendance(S, q.data);
    if (!s) { await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Это занятие уже удалено' }); return; }
    if (!(await saveState(coach.owner, row.version, S))) { await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Данные только что изменились, нажмите ещё раз' }); return; }
    const view = attendanceView(S, s);
    await tg(bot.token, 'editMessageText', { chat_id: chat.id, message_id: q.message.message_id, text: view.text, reply_markup: view.reply_markup }).catch(() => {});
    await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Сохранено' });
    return;
  }
  if (!m?.text) return;
  const link = m.text.match(/^\/start link_([a-f0-9]{32})$/);
  if (link) return linkAsk(bot, chat.id, link[1], coach);
  if (!coach) return tg(bot.token, 'sendMessage', { chat_id: chat.id, text: WELCOME });
  const S = await stateOf(coach.owner);
  if (m.text.startsWith('/start')) await tg(bot.token, 'sendMessage', { chat_id: chat.id, text: startText(S, { receipts: !!coach.receipts_report }) });
  else if (!S) return;
  else if (m.text.startsWith('/today')) await tg(bot.token, 'sendMessage', { chat_id: chat.id, text: dayText(S, nowFor(S)) });
  else if (m.text.startsWith('/next')) await tg(bot.token, 'sendMessage', { chat_id: chat.id, text: nextText(S, nowFor(S)) });
  else if (m.text.startsWith('/receipts') && coach.receipts_report) { const { from, to } = receiptsSoFar(nowFor(S)); await sendReport(bot.token, chat.id, receiptsReport(S, from, to)); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const path = new URL(req.url).pathname.replace(/^.*?\/telegram/, '');
  try {
    if (path === '/tick' || path === '/cleanup') {
      const { data: ok } = await admin.rpc('check_cron_secret', { candidate: req.headers.get('x-cron-secret') ?? '' });
      if (ok !== true) return json({ error: 'forbidden' }, 403);
      return json(path === '/tick' ? await tick() : await cleanup());
    }
    // The secret comes in Telegram's X-Telegram-Bot-Api-Secret-Token header (setWebhook secret_token).
    // The old webhook URL with the secret in the path keeps working until setWebhook is called again.
    const hook = path.match(/^\/hook(?:\/([a-f0-9]{32}))?$/);
    if (hook) {
      // Always 200, or Telegram keeps retrying the update: a failure is logged, never answered with 500.
      try { await webhook(hook[1] ?? req.headers.get('x-telegram-bot-api-secret-token') ?? '', await req.json().catch(() => null)); }
      catch (e) { console.error(`telegram webhook: ${(e as Error).message}`); }
      return json({ ok: true });
    }
    // The login through the bot is gone (coaches sign in with Google): an old page gets a clear answer.
    if (path.startsWith('/login/')) return json({ error: 'Вход теперь через Google. Обновите страницу.' }, 410);

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    const user = auth?.user;
    if (!user) return json({ error: 'Войдите в сервис' }, 401);
    const { data: cur } = await admin.from('telegram_links').select('owner, chat_id, receipts_report, blocked_at').eq('owner', user.id).maybeSingle();
    const link = cur as Coach | null;
    const bot = await getBot();

    if (path === '/status') return json(status(link, bot));
    if (path === '/link') return await linkStart(req, user.id);
    // The chat is forgotten, the row with the journal's other settings stays.
    if (path === '/unlink') {
      const { error } = await admin.from('telegram_links').update({ chat_id: null, blocked_at: null }).eq('owner', user.id);
      if (error) throw new Error(error.message);
      return json(status(null, bot));
    }

    if (path === '/test') {
      if (!link?.chat_id) return json({ error: `Откройте @${bot.bot_name} и нажмите Start` }, 400);
      const S = await stateOf(user.id);
      await tg(bot.token, 'sendMessage', {
        chat_id: link.chat_id,
        text: `Проверка связи: напоминания будут приходить сюда.${S ? `\n\n${dayText(S, nowFor(S))}` : ''}`,
      });
      return json({ ok: true });
    }

    // The bot is shared now: nobody brings their own token, and a coach's chat stays linked to their account.
    if (path === '/connect' || path === '/disconnect') return json({ error: 'Бот общий для всех тренеров, подключать его не нужно' }, 410);

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
