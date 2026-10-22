// Telegram for «Дорожка» in the cloud. One function, four kinds of callers:
//   POST /telegram/tick            — pg_cron every minute (x-cron-secret, checked by the database): sends due reminders
//   POST /telegram/hook            — webhook of the shared bot (secret in X-Telegram-Bot-Api-Secret-Token; the old /hook/<secret> still works): sign-in and sign-up, attendance buttons, /today, /next, /receipts (owner only)
//   POST /telegram/login/start|poll — the login screen: sign in (or create a journal) by confirming in the bot
//   POST /telegram/status|test     — the signed-in coach from the app
// Every coach has their own account and data; the bot tells them apart by their Telegram chat.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { applyAttendance, attendanceView, dayText, dueMessages, forgetPhotos, loginPlace, nextText, photoForms, receiptsReport, receiptsSoFar, startText, textChunks, wallNow } from '../_shared/schedule.mjs';

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
// Long text in parts, then receipt photos as albums of up to 10. A failed album is logged, the rest still go out.
// Returns the ids of payments whose photo reached the chat.
async function sendReport(token: string, chatId: number, m: { text: string; photos?: { id: string; img: string; caption: string }[] }) {
  for (const part of textChunks(m.text)) await tg(token, 'sendMessage', { chat_id: chatId, text: part });
  const sent: string[] = [];
  for (const { fd, ids } of photoForms(chatId, m.photos || [])) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
    if (out.ok) sent.push(...ids); else console.error(`telegram receipts album: ${out.description}`);
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
// Drops photos that are now in the chat. Retried if the app saved meanwhile.
async function dropSentPhotos(owner: string, ids: string[], day: string) {
  for (let i = 0; i < 5 && ids.length; i++) {
    const { data: row } = await admin.from('app_state').select('data, version').eq('owner', owner).maybeSingle();
    if (!row?.data || !forgetPhotos(row.data, ids, day)) return;
    if (await saveState(owner, row.version, row.data)) return;
  }
  console.error('telegram receipts: photos sent but not removed (state kept changing)');
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
        const ids = await sendReport(bot.token, l.chat_id as number, m);
        if (m.purge) await dropSentPhotos(l.owner, ids, m.key.slice(9) + '-20');
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

/* ---------- login through the bot ---------- */
const LOGIN_TTL_MIN = 10;
const CODE_TRIES = 5;
const fresh = () => new Date(Date.now() - LOGIN_TTL_MIN * 60_000).toISOString();

// Limits are per caller address, so a stranger requesting codes can't lock the coach out (there is no shared limit
// any longer: one source could close the login for everybody). Supabase does not document a trusted client-IP header.
// The platform sits behind Cloudflare, which overwrites cf-connecting-ip with the real address; x-forwarded-for keeps
// whatever the caller sent in front, and the proxy appends the real address last, so never trust its first entry.
const callerIp = (req: Request) =>
  req.headers.get('cf-connecting-ip')?.trim() || (req.headers.get('x-forwarded-for') ?? '').split(',').pop()!.trim() || 'unknown';

async function loginStart(req: Request) {
  const bot = await getBot();
  await admin.from('login_requests').delete().lt('created_at', new Date(Date.now() - 864e5).toISOString());
  const ip = callerIp(req);
  const { count: mine } = await admin.from('login_requests').select('nonce', { count: 'exact', head: true }).eq('ip', ip).gt('created_at', fresh());
  if ((mine ?? 0) >= 6) return json({ error: 'Слишком много попыток входа. Подождите 10 минут.' }, 429);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 400);
  const { error } = await admin.from('login_requests').insert({ nonce, code, ip, ua });
  if (error) throw new Error(error.message);
  return json({ nonce, code, bot: bot.bot_name, ttl: LOGIN_TTL_MIN * 60 });
}

async function loginPoll(nonce: string) {
  const { data: r } = await admin.from('login_requests').select('*').eq('nonce', nonce).gt('created_at', fresh()).maybeSingle();
  if (!r || r.used_at) return json({ status: 'expired' });
  if (!r.approved_at) return json({ status: 'wait' });
  // Use the request once: only the poll that flips used_at gets the session.
  const { data: took } = await admin.from('login_requests').update({ used_at: new Date().toISOString() })
    .eq('nonce', nonce).is('used_at', null).select('owner');
  if (!took?.length) return json({ status: 'expired' });
  const { data: u } = await admin.auth.admin.getUserById(r.owner);
  if (!u?.user?.email) throw new Error('Аккаунт тренера не найден');
  // generateLink sends no email; the site verifies the hashed token and gets a normal session.
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  if (error) throw new Error(error.message);
  await tellLogin(r).catch((e) => console.error(`telegram login notice: ${(e as Error).message}`));
  return json({ status: 'ok', token_hash: link.properties.hashed_token });
}

// After every login the coach hears about it, with a button that ends every session if it was not them
// (someone sent them a login link and they pressed «Да, войти»).
async function tellLogin(r: { owner: string; ip?: string; ua?: string; created_at: string }) {
  const { data: l } = await admin.from('telegram_links').select('chat_id').eq('owner', r.owner).maybeSingle();
  if (!l?.chat_id) return;
  const bot = await getBot();
  await tg(bot.token, 'sendMessage', {
    chat_id: l.chat_id,
    text: `Выполнен вход в Дорожку: ${loginPlace(r)}.\nЕсли это были не вы, завершите все сеансы: журнал закроется на всех устройствах, и войти можно будет только заново через этого бота.`,
    reply_markup: { inline_keyboard: [[{ text: 'Это не я — завершить все сеансы', callback_data: 'sout|all' }]] },
  });
}
// supabase-js 2.45 ends sessions only by a user's own JWT: auth.admin.signOut(jwt, 'global') revokes every refresh
// token of that user. The function has no JWT of the coach, so it signs in as them once (magic link, verified here)
// and signs that session out globally. Access tokens already issued stay valid until they expire (an hour at most).
async function signOutEverywhere(owner: string) {
  const { data: u } = await admin.auth.admin.getUserById(owner);
  if (!u?.user?.email) throw new Error('Аккаунт тренера не найден');
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  if (error) throw new Error(error.message);
  const once = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: v, error: e2 } = await once.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (e2 || !v.session) throw new Error(e2?.message || 'Не удалось завершить сеансы');
  const { error: e3 } = await admin.auth.admin.signOut(v.session.access_token, 'global');
  if (e3) throw new Error(e3.message);
}
async function signOutAnswer(bot: Bot, q: any, coach: Coach | null) {
  let text = 'Все сеансы завершены. Журнал закрыт на всех устройствах; войдите заново через «Войти или создать журнал» на сайте.';
  if (!coach) text = 'Этот чат не связан с журналом.';
  else {
    try { await signOutEverywhere(coach.owner); }
    catch (e) { console.error(`telegram signout: ${(e as Error).message}`); text = 'Не получилось завершить сеансы. Нажмите кнопку ещё раз через минуту.'; }
  }
  const failed = text.startsWith('Не получилось');
  await tg(bot.token, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text ?? ''}\n\n${text}`,
    ...(failed ? { reply_markup: q.message.reply_markup } : {}) }).catch(() => {});
  await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id, text: failed ? 'Ошибка' : 'Сеансы завершены' }).catch(() => {});
}

const openRequest = async (nonce: string) =>
  (await admin.from('login_requests').select('nonce, code, ip, ua, created_at').eq('nonce', nonce).is('approved_at', null).gt('created_at', fresh()).maybeSingle()).data;
const approve = async (nonce: string, owner: string) =>
  !!(await admin.from('login_requests').update({ owner, approved_at: new Date().toISOString() })
    .eq('nonce', nonce).is('approved_at', null).gt('created_at', fresh()).select('nonce')).data?.length;
const STALE = 'Ссылка для входа устарела. Нажмите «Начать через Telegram» на сайте ещё раз.';
const WARN = 'Нажимайте, только если вы сами сейчас на dorozhka.vercel.app, видите этот код и узнаёте браузер и время. Если ссылку прислал кто-то другой — нажмите «Это не я».';

// A coach signs in; a chat the service has never seen is offered a new, empty journal instead.
async function loginAsk(bot: Bot, chatId: number, nonce: string, coach: Coach | null) {
  const r = await openRequest(nonce);
  if (!r) return tg(bot.token, 'sendMessage', { chat_id: chatId, text: STALE });
  const [title, yes, act] = coach ? ['Вход в Дорожку', 'Да, войти', 'login'] : ['Новый журнал в Дорожке', 'Да, создать журнал', 'reg'];
  const intro = coach ? '' : '\nБудет создан ваш личный журнал: клиенты, расписание и оплаты видны только вам, напоминания приходят сюда.\n';
  return tg(bot.token, 'sendMessage', {
    chat_id: chatId,
    text: `${title}\n${intro}\nКод на экране: ${r.code}\nЗапрос: ${loginPlace(r)}\n${WARN}`,
    reply_markup: { inline_keyboard: [[{ text: yes, callback_data: `${act}|${nonce}|y` }, { text: 'Это не я', callback_data: `${act}|${nonce}|n` }]] },
  });
}

// Creates the coach's account (no email or password: the address is internal and never mailed) and links the chat.
async function register(chatId: number, from: any): Promise<string> {
  const again = await coachByChat(chatId);
  if (again) return again.owner;
  const { data, error } = await admin.auth.admin.createUser({
    email: `tg${chatId}@users.dorozhka.example`,
    email_confirm: true,
    user_metadata: { telegram_id: chatId, name: [from?.first_name, from?.last_name].filter(Boolean).join(' '), username: from?.username ?? null },
  });
  if (error || !data?.user) throw new Error(error?.message || 'Не удалось создать аккаунт');
  const { error: e2 } = await admin.from('telegram_links').insert({ owner: data.user.id, chat_id: chatId });
  if (e2) { await admin.auth.admin.deleteUser(data.user.id).catch(() => {}); throw new Error(e2.message); }
  return data.user.id;
}

async function loginAnswer(bot: Bot, q: any, coach: Coach | null) {
  const [act, nonce, ans] = String(q.data).split('|');
  const chatId = q.message.chat.id;
  let text = 'Вход отклонён. Если это были не вы — ничего делать не нужно.';
  if (ans === 'y') {
    if (!(await openRequest(nonce))) text = STALE;
    else if (act === 'login' && coach) text = (await approve(nonce, coach.owner)) ? 'Вход подтверждён — вернитесь в браузер.' : STALE;
    else if (act === 'reg') {
      const owner = await register(chatId, q.from);
      text = (await approve(nonce, owner))
        ? 'Журнал создан, вход подтверждён — вернитесь в браузер.\n\nСюда будут приходить напоминания о занятиях, сводка дня в 7:00 и кнопки отметки посещения. Клиентам бот ничего не пишет.'
        : STALE;
    }
  } else {
    await admin.from('login_requests').delete().eq('nonce', nonce).is('approved_at', null);
  }
  await tg(bot.token, 'editMessageText', { chat_id: chatId, message_id: q.message.message_id, text }).catch(() => {});
  await tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
}

const WELCOME = 'Это бот «Дорожки» — журнала тренера по плаванию.\n\nЧтобы создать свой журнал, откройте dorozhka.vercel.app и нажмите «Начать через Telegram». Если на компьютере нет Telegram, отправьте сюда код из 6 цифр с экрана входа.';

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
    if (/^(login|reg)\|/.test(String(q.data))) return loginAnswer(bot, q, coach);
    if (String(q.data) === 'sout|all') return signOutAnswer(bot, q, coach);
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
  const login = m.text.match(/^\/start login_([a-f0-9]{32})$/);
  if (login) return loginAsk(bot, chat.id, login[1], coach);
  // The code from the login screen, typed here (when the link cannot open Telegram): asks the same question.
  const typed = m.text.replace(/\s/g, '');
  if (/^\d{6}$/.test(typed)) {
    // At most CODE_TRIES wrong codes per chat in 10 minutes, so a code can't be guessed by trying them all.
    const { count: wrong } = await admin.from('login_code_failures').select('chat_id', { count: 'exact', head: true }).eq('chat_id', chat.id).gt('at', fresh());
    if ((wrong ?? 0) >= CODE_TRIES) return tg(bot.token, 'sendMessage', { chat_id: chat.id, text: 'Слишком много неверных кодов. Подождите 10 минут и нажмите «Новый код» на сайте.' });
    const { data: r } = await admin.from('login_requests').select('nonce').eq('code', typed).is('approved_at', null)
      .gt('created_at', fresh()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!r) {
      await admin.from('login_code_failures').delete().lt('at', new Date(Date.now() - 864e5).toISOString());
      await admin.from('login_code_failures').insert({ chat_id: chat.id });
    }
    if (!r) return tg(bot.token, 'sendMessage', { chat_id: chat.id, text: 'Такого кода нет или он устарел. Нажмите «Новый код» на сайте и отправьте его сюда.' });
    return loginAsk(bot, chat.id, r.nonce, coach);
  }
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
    if (path === '/tick') {
      const { data: ok } = await admin.rpc('check_cron_secret', { candidate: req.headers.get('x-cron-secret') ?? '' });
      if (ok !== true) return json({ error: 'forbidden' }, 403);
      return json(await tick());
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
    if (path === '/login/start') return await loginStart(req);
    if (path === '/login/poll') {
      const { nonce } = await req.json().catch(() => ({}));
      if (!/^[a-f0-9]{32}$/.test(String(nonce ?? ''))) return json({ error: 'bad request' }, 400);
      return await loginPoll(nonce);
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    const user = auth?.user;
    if (!user) return json({ error: 'Войдите в сервис' }, 401);
    const { data: cur } = await admin.from('telegram_links').select('owner, chat_id, receipts_report, blocked_at').eq('owner', user.id).maybeSingle();
    const link = cur as Coach | null;
    const bot = await getBot();

    if (path === '/status') return json(status(link, bot));

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
