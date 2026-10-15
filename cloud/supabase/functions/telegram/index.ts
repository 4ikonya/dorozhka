// Telegram for «Дорожка» in the cloud. One function, four kinds of callers:
//   POST /telegram/tick            — pg_cron every minute (x-cron-secret, checked by the database): sends due reminders
//   POST /telegram/hook/<secret>   — Telegram webhook: /start links the chat, /today, /next, /receipts, login confirm
//   POST /telegram/login/start|poll — the login screen: sign in by confirming in the coach's bot
//   POST /telegram/status|connect|test|disconnect — the signed-in coach from the app
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { applyAttendance, attendanceView, dayText, dueMessages, nextText, photoForms, receiptsReport, receiptsSoFar, startText, textChunks, wallNow } from '../_shared/schedule.mjs';

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

type Link = { owner: string; token: string; bot_name: string; chat_id: number | null; hook_secret: string };

async function tg(token: string, method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
  if (!out.ok) throw new Error(out.description || 'Ошибка Telegram');
  return out.result;
}
// Long text in parts, then receipt photos as albums of up to 10. A failed album is logged, the rest still go out.
async function sendReport(token: string, chatId: number, m: { text: string; photos?: { img: string; caption: string }[] }) {
  for (const part of textChunks(m.text)) await tg(token, 'sendMessage', { chat_id: chatId, text: part });
  for (const fd of photoForms(chatId, m.photos || [])) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({ ok: false, description: 'Telegram ответил непонятно' }));
    if (!out.ok) console.error(`telegram receipts album: ${out.description}`);
  }
}
async function stateOf(owner: string) {
  const { data } = await admin.from('app_state').select('data').eq('owner', owner).maybeSingle();
  return data?.data ?? null;
}
const nowFor = (S: any) => wallNow(new Date(), S?.settings?.tz || DEFAULT_TZ);
const status = (l: Pick<Link, 'bot_name' | 'chat_id'> | null) =>
  ({ connected: !!l, chatLinked: !!l?.chat_id, botName: l?.bot_name ?? '' });

async function tick() {
  const { data: links } = await admin.from('telegram_links').select('*').not('chat_id', 'is', null);
  let sent = 0;
  for (const l of (links ?? []) as Link[]) {
    const S = await stateOf(l.owner);
    if (!S) continue;
    const { data: rows } = await admin.from('sent_reminders').select('key').eq('owner', l.owner);
    const done = new Set((rows ?? []).map((r) => r.key));
    for (const m of dueMessages(S, nowFor(S), (k: string) => done.has(k))) {
      // Claim the key first so two overlapping ticks never send the same message.
      const { error } = await admin.from('sent_reminders').insert({ owner: l.owner, key: m.key });
      if (error) continue;
      try {
        if (m.photos) await sendReport(l.token, l.chat_id as number, m);
        else await tg(l.token, 'sendMessage', { chat_id: l.chat_id, text: m.text, ...(m.reply_markup ? { reply_markup: m.reply_markup } : {}) });
        sent++;
      } catch (e) {
        await admin.from('sent_reminders').delete().eq('owner', l.owner).eq('key', m.key);
        console.error(`telegram ${m.key}: ${(e as Error).message}`);
      }
    }
  }
  return { ok: true, sent };
}

/* ---------- login through the bot ---------- */
const LOGIN_TTL_MIN = 10;
const fresh = () => new Date(Date.now() - LOGIN_TTL_MIN * 60_000).toISOString();

// Limits are per caller address, so a stranger requesting codes can't lock the coach out.
const callerIp = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

async function loginStart(req: Request) {
  const { data: l } = await admin.from('telegram_links').select('bot_name').not('chat_id', 'is', null).limit(1).maybeSingle();
  if (!l) return json({ error: 'Бот ещё не подключён. Войдите по почте и подключите его в разделе «Ещё».' }, 409);
  await admin.from('login_requests').delete().lt('created_at', new Date(Date.now() - 864e5).toISOString());
  const ip = callerIp(req);
  const { count: mine } = await admin.from('login_requests').select('nonce', { count: 'exact', head: true }).eq('ip', ip).gt('created_at', fresh());
  const { count: all } = await admin.from('login_requests').select('nonce', { count: 'exact', head: true }).gt('created_at', fresh());
  if ((mine ?? 0) >= 6 || (all ?? 0) >= 300) return json({ error: 'Слишком много попыток входа. Подождите 10 минут.' }, 429);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const { error } = await admin.from('login_requests').insert({ nonce, code, ip });
  if (error) throw new Error(error.message);
  return json({ nonce, code, bot: l.bot_name, ttl: LOGIN_TTL_MIN * 60 });
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
  return json({ status: 'ok', token_hash: link.properties.hashed_token });
}

async function loginAsk(l: Link, chatId: number, nonce: string) {
  const { data: r } = await admin.from('login_requests').select('code').eq('nonce', nonce)
    .is('approved_at', null).gt('created_at', fresh()).maybeSingle();
  if (!r) { await tg(l.token, 'sendMessage', { chat_id: chatId, text: 'Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.' }); return; }
  await tg(l.token, 'sendMessage', {
    chat_id: chatId,
    text: `Вход в Дорожку\n\nКод на экране: ${r.code}\nНажмите «Да, войти», только если вы сами сейчас входите на dorozhka.vercel.app и видите этот код. Если ссылку прислал кто-то другой — нажмите «Это не я».`,
    reply_markup: { inline_keyboard: [[{ text: 'Да, войти', callback_data: `login|${nonce}|y` }, { text: 'Это не я', callback_data: `login|${nonce}|n` }]] },
  });
}

async function loginAnswer(l: Link, q: any) {
  const [, nonce, ans] = String(q.data).split('|');
  let text = 'Вход отклонён.';
  if (ans === 'y') {
    const { data: ok } = await admin.from('login_requests').update({ owner: l.owner, approved_at: new Date().toISOString() })
      .eq('nonce', nonce).is('approved_at', null).gt('created_at', fresh()).select('nonce');
    text = ok?.length ? 'Вход подтверждён — вернитесь в браузер.' : 'Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.';
  } else {
    await admin.from('login_requests').delete().eq('nonce', nonce).is('approved_at', null);
  }
  await tg(l.token, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text }).catch(() => {});
  await tg(l.token, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
}

async function webhook(secret: string, update: any) {
  const { data } = await admin.from('telegram_links').select('*').eq('hook_secret', secret).maybeSingle();
  const l = data as Link | null;
  const q = update?.callback_query;
  if (l && q) {
    if (Number(l.chat_id) !== q.message?.chat?.id) return;
    if (String(q.data).startsWith('login|')) return loginAnswer(l, q);
    // Bump the version so an open app sees the change and reloads instead of overwriting it.
    const { data: row } = await admin.from('app_state').select('data, version').eq('owner', l.owner).maybeSingle();
    const S = row?.data;
    const s = S && applyAttendance(S, q.data);
    if (!s) { await tg(l.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Это занятие уже удалено' }); return; }
    const { data: saved } = await admin.from('app_state').update({ data: S, version: row.version + 1, updated_at: new Date().toISOString() })
      .eq('owner', l.owner).eq('version', row.version).select('version');
    if (!saved?.length) { await tg(l.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Данные только что изменились, нажмите ещё раз' }); return; }
    const view = attendanceView(S, s);
    await tg(l.token, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: view.text, reply_markup: view.reply_markup }).catch(() => {});
    await tg(l.token, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Сохранено' });
    return;
  }
  const m = update?.message;
  if (!l || !m?.text) return;
  const login = m.text.match(/^\/start login_([a-f0-9]{32})$/);
  if (login) {
    if (l.chat_id && Number(l.chat_id) === m.chat.id) await loginAsk(l, m.chat.id, login[1]);
    return;
  }
  // The coach typed the code from the login screen (works when the link cannot open Telegram).
  const typed = m.text.replace(/\s/g, '');
  if (/^\d{6}$/.test(typed) && l.chat_id && Number(l.chat_id) === m.chat.id) {
    const { data: r } = await admin.from('login_requests').select('nonce').eq('code', typed).is('approved_at', null)
      .gt('created_at', fresh()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { data: ok } = r
      ? await admin.from('login_requests').update({ owner: l.owner, approved_at: new Date().toISOString() })
        .eq('nonce', r.nonce).is('approved_at', null).gt('created_at', fresh()).select('nonce')
      : { data: null };
    await tg(l.token, 'sendMessage', { chat_id: m.chat.id, text: ok?.length ? 'Вход подтверждён — вернитесь в браузер.' : 'Такого кода нет или он устарел. Нажмите «Новый код» на сайте и отправьте его сюда.' });
    return;
  }
  const S = await stateOf(l.owner);
  if (!l.chat_id && m.text.startsWith('/start')) {
    await admin.from('telegram_links').update({ chat_id: m.chat.id }).eq('owner', l.owner);
    await tg(l.token, 'sendMessage', { chat_id: m.chat.id, text: startText(S) });
  } else if (Number(l.chat_id) === m.chat.id && S) {
    if (m.text.startsWith('/today')) await tg(l.token, 'sendMessage', { chat_id: m.chat.id, text: dayText(S, nowFor(S)) });
    else if (m.text.startsWith('/next')) await tg(l.token, 'sendMessage', { chat_id: m.chat.id, text: nextText(S, nowFor(S)) });
    else if (m.text.startsWith('/receipts')) { const { from, to } = receiptsSoFar(nowFor(S)); await sendReport(l.token, m.chat.id, receiptsReport(S, from, to)); }
  }
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
    const hook = path.match(/^\/hook\/([a-f0-9]{32})$/);
    if (hook) {
      await webhook(hook[1], await req.json().catch(() => null));
      return json({ ok: true }); // always 200, or Telegram keeps retrying
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
    const { data: cur } = await admin.from('telegram_links').select('*').eq('owner', user.id).maybeSingle();
    const link = cur as Link | null;

    if (path === '/status') return json(status(link));

    if (path === '/connect') {
      const { token } = await req.json().catch(() => ({}));
      const clean = String(token ?? '').trim();
      if (!/^\d+:[\w-]{20,}$/.test(clean)) return json({ error: 'Это не похоже на токен от @BotFather' }, 400);
      const me = await tg(clean, 'getMe');
      const hookSecret = crypto.randomUUID().replaceAll('-', '');
      await tg(clean, 'setWebhook', { url: `${SB_URL}/functions/v1/telegram/hook/${hookSecret}`, allowed_updates: ['message', 'callback_query'] });
      const row = { owner: user.id, token: clean, bot_name: me.username, chat_id: null, hook_secret: hookSecret };
      const { error } = await admin.from('telegram_links').upsert(row);
      if (error) throw new Error(error.message);
      return json(status(row));
    }

    if (path === '/test') {
      if (!link?.chat_id) return json({ error: 'Сначала нажмите Start в чате с ботом' }, 400);
      const S = await stateOf(user.id);
      await tg(link.token, 'sendMessage', {
        chat_id: link.chat_id,
        text: `Проверка связи: напоминания будут приходить сюда.${S ? `\n\n${dayText(S, nowFor(S))}` : ''}`,
      });
      return json({ ok: true });
    }

    if (path === '/disconnect') {
      if (link) {
        await tg(link.token, 'deleteWebhook').catch(() => {});
        await admin.from('telegram_links').delete().eq('owner', user.id);
      }
      return json(status(null));
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
