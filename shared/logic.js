// The business logic of «Дорожка», one copy for every place that needs it: the app (dorozhka.html), the laptop server
// and the cloud function. Pure functions over the app state S.
// A classic script, so the app can load it even when the file is opened straight from disk (file:// can't load modules):
// it puts everything on globalThis.DorozhkaLogic. Node and Deno import it through shared/schedule.mjs.
// All times are "wall clock" values in the coach's time zone, stored in the UTC fields of a Date.
(function () {
'use strict';

const TYPE = { baby: 'Грудничковое', individual: 'Индивидуальное', split: 'Сплит', minigroup: 'Мини-группа', group: 'Групповое' };
const LEAD = { '30m': 30, '2h': 120, '1d': 1440 };
const KIND = { trial: 'Пробное ', makeup: 'Отработка ' };
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = (n) => String(n).padStart(2, '0');

const DEFAULT_TZ = 'Asia/Almaty';
function wallNow(now, tz) {
  if (!tz) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()));
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return tz === DEFAULT_TZ ? wallNow(now) : wallNow(now, DEFAULT_TZ); }
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
const startOf = (s) => {
  const [y, m, d] = s.date.split('-').map(Number);
  const [h, mi] = s.start.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi));
};
const dayKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const durOf = (s) => s.dur || (s.type === 'baby' ? 30 : 45);
const endOf = (s) => startOf(s).getTime() + durOf(s) * 60000;
const hm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const byStart = (a, b) => startOf(a) - startOf(b);

function titleOf(S, s) {
  const name = s.groupId
    ? (S.groups.find((g) => g.id === s.groupId)?.name || 'Группа').split(' ·')[0]
    : s.clientIds.map((id) => S.clients.find((c) => c.id === id)?.name || '—').join(', ');
  return (KIND[s.kind] || '') + name;
}
/** The latest earlier session of the same client or group that left a note for the next time. */
function prevSession(S, s) {
  const t = startOf(s);
  const same = (x) => (s.groupId ? x.groupId === s.groupId : !x.groupId && x.clientIds[0] === s.clientIds[0]);
  return S.sessions.filter((x) => x.id !== s.id && same(x) && startOf(x) < t && x.next).sort(byStart).pop() || null;
}
const prevNote = (S, s) => prevSession(S, s)?.next || '';

/**
 * Is the session taken from the client's package? Yes if they came, or did not come without warning
 * (unless the coach turned that off: settings.chargeNoShow === false; missing means yes, as in a new journal).
 * A trial session is paid separately or free, never taken from a package.
 */
function charged(S, s, cid) {
  if (s.kind === 'trial') return false;
  const a = s.att?.[cid];
  return a === 'present' || (a === 'absent' && S.settings?.chargeNoShow !== false);
}
/**
 * The client's package balance on `today` (YYYY-MM-DD). Charged sessions are taken from the oldest payment first.
 * New payments have no term; an old one with a term (p.until) covers only sessions up to that date, and what is
 * left on it after the date is burned.
 * remaining < 0 is a debt; until is the nearest end date of a payment that still has sessions.
 */
function balance(S, cid, today) {
  const used = S.sessions.filter((s) => !s.cancelled && s.clientIds.includes(cid) && charged(S, s, cid)).sort(byStart);
  const pays = S.payments.filter((p) => p.clientId === cid || p.with === cid).sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ p, left: p.sessions }));
  let debt = 0;
  for (const s of used) { const b = pays.find((x) => x.left > 0 && (!x.p.until || s.date <= x.p.until)); if (b) b.left--; else debt++; }
  const active = pays.filter((x) => !x.p.until || x.p.until >= today);
  const remaining = active.reduce((t, x) => t + x.left, 0) - debt;
  const aPaid = active.reduce((t, x) => t + x.p.sessions, 0);
  return {
    paid: pays.reduce((t, x) => t + x.p.sessions, 0),
    aPaid,
    aUsed: aPaid - Math.max(0, remaining),
    used: used.length,
    remaining,
    burned: pays.filter((x) => x.p.until && x.p.until < today).reduce((t, x) => t + x.left, 0),
    until: active.filter((x) => x.left > 0 && x.p.until).map((x) => x.p.until).sort()[0] || null,
  };
}
const remaining = (S, cid, today) => balance(S, cid, today).remaining;
function needPayment(S, wnow) {
  const today = dayKey(wnow);
  return S.clients.filter((c) => {
    const up = S.sessions.filter((s) => !s.cancelled && s.clientIds.includes(c.id) && !isPaused(c, s.date) && !s.att?.[c.id] && startOf(s) > wnow);
    return up.length && !up.every((s) => s.kind === 'trial') && remaining(S, c.id, today) <= 1;
  }).map((c) => `${c.name} (осталось ${remaining(S, c.id, today)})`);
}
function inText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `Через ${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  return h < 24 ? `Через ${h} ч${mm ? ` ${mm} мин` : ''}` : 'Завтра';
}
function reminderText(S, s, wnow) {
  const note = prevNote(S, s);
  return `${inText(startOf(s) - wnow)}: ${s.start} — ${titleOf(S, s)}\n${TYPE[s.type] || ''}, ${s.place}${note ? `\nС прошлого раза: ${note}` : ''}`;
}
function dayText(S, wnow) {
  const today = S.sessions.filter((s) => !s.cancelled && s.date === dayKey(wnow) && activeClients(S, s).length).sort(byStart);
  const day = DAYS[wnow.getUTCDay()];
  const head = `${day[0].toUpperCase()}${day.slice(1)}, ${wnow.getUTCDate()} ${MONTHS[wnow.getUTCMonth()]}`;
  const list = today.length ? today.map((s) => `${s.start} — ${titleOf(S, s)} (${s.place})`).join('\n') : 'Занятий нет';
  const pay = needPayment(S, wnow);
  return `${head}\n${list}${pay.length ? `\n\nНужна оплата: ${pay.join(', ')}` : ''}`;
}
function nextText(S, wnow) {
  const next = S.sessions.filter((s) => !s.cancelled && activeClients(S, s).length && startOf(s) > wnow).sort(byStart)[0];
  return next ? reminderText(S, next, wnow) : 'Ближайших занятий нет.';
}
/** opts.receipts: this coach has the monthly receipts report (a feature of the service owner only). */
function startText(S, opts = {}) {
  const lead = LEAD[S?.settings?.remindCoach || '2h'] || 120;
  return `Готово. Буду напоминать о занятиях за ${lead >= 60 ? `${lead / 60} ч` : `${lead} мин`} и присылать сводку дня в 7:00.\n${opts.receipts ? 'Каждое 20-е число пришлю чеки за месяц (с 20-го по 19-е).\n' : ''}Команды: /today — занятия на сегодня, /next — ближайшее${opts.receipts ? ', /receipts — чеки с 20-го числа по сегодня' : ''}.`;
}
// c.pause is the current or next pause; c.pauses keeps the finished ones, so old sessions stay paused.
const pausesOf = (c) => [...(c?.pauses || []), ...(c?.pause ? [c.pause] : [])];
const pauseAt = (c, date) => pausesOf(c).find((p) => p.from <= date && date <= p.to);
const isPaused = (c, date) => !!pauseAt(c, date);
const onVacation = (S, date) => (S.vacations || []).some((v) => v.from <= date && date <= v.to);
/** Clients expected at the session: everyone not on pause that day. */
const activeClients = (S, s) => s.clientIds.filter((id) => !isPaused(S.clients.find((c) => c.id === id), s.date));

const ATT_LABEL = { present: 'был', absent: 'не предупредил', excused: 'предупредил' };
const ATT_CODE = { p: 'present', a: 'absent', e: 'excused' };
function attendanceView(S, s) {
  const ids = activeClients(S, s);
  const lines = ids.map((id) => {
    const c = S.clients.find((x) => x.id === id);
    return `${c?.name || '—'}: ${s.att?.[id] ? ATT_LABEL[s.att[id]] : '—'}`;
  });
  const keyboard = ids.map((id) => {
    const first = (S.clients.find((x) => x.id === id)?.name || '—').split(' ')[0];
    const mark = (v) => (s.att?.[id] === ATT_CODE[v] ? '• ' : '');
    return [
      { text: `${mark('p')}${first}: был`, callback_data: `a|${s.id}|${id}|p` },
      { text: `${mark('a')}не предупр.`, callback_data: `a|${s.id}|${id}|a` },
      { text: `${mark('e')}предупр.`, callback_data: `a|${s.id}|${id}|e` },
    ];
  });
  const done = ids.every((id) => s.att?.[id]);
  const ext = S.sessions.find((x) => x.extOf === s.id);
  if (ext) { const d = dateOf(ext.date); lines.push(`Предупредили — добавлена отработка: ${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${ext.start}`); }
  return {
    text: `${done ? 'Отмечено' : 'Отметьте посещение'}: ${s.start} — ${titleOf(S, s)}\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}
/** Applies a button press "a|session|client|p|a|e". Returns the session, or null if the data is stale. */
function applyAttendance(S, data) {
  const [kind, sid, cid, code] = String(data).split('|');
  const s = S.sessions.find((x) => x.id === sid);
  if (kind !== 'a' || !s || !s.clientIds.includes(cid) || !ATT_CODE[code]) return null;
  s.att = s.att || {};
  if (s.att[cid] === ATT_CODE[code]) delete s.att[cid]; else s.att[cid] = ATT_CODE[code];
  syncMakeup(S, s);
  return s;
}

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const weekday = (d) => (d.getUTCDay() + 6) % 7; // 0 = Monday, as in the app
/**
 * Everyone at a session warned they would miss it: nothing is charged, so the series gets one more session at its end —
 * a make-up on the client's next plan day that is free. Undoing the mark removes it while it is still unmarked.
 * Group sessions are left alone: the group keeps its own schedule.
 */
function syncMakeup(S, s) {
  if (s.groupId || s.kind === 'trial' || s.cancelled) return null;
  const ids = s.clientIds.filter((id) => s.att?.[id] || !isPaused(S.clients.find((c) => c.id === id), s.date));
  const want = ids.length > 0 && ids.every((id) => s.att?.[id] === 'excused');
  const ext = S.sessions.find((x) => x.extOf === s.id);
  if (!want) {
    if (ext && !Object.keys(ext.att || {}).length) S.sessions = S.sessions.filter((x) => x !== ext);
    return null;
  }
  if (ext) return ext;
  const key = [...s.clientIds].sort().join(',');
  const last = S.sessions.filter((x) => !x.groupId && !x.cancelled && [...x.clientIds].sort().join(',') === key)
    .reduce((a, x) => (x.date > a ? x.date : a), s.date);
  const pl = S.clients.find((c) => c.id === s.clientIds[0])?.plan;
  const slots = pl?.slots && Object.keys(pl.slots).length ? pl.slots
    : pl?.days ? Object.fromEntries(pl.days.map((d) => [d, pl.time])) : { [weekday(dateOf(s.date))]: s.start };
  const gap = Math.max(0, +(S.settings?.breakMin ?? 10) || 0), dur = durOf(s);
  const busy = (date, start) => {
    const a = toMin(start), b = a + dur;
    return S.sessions.some((x) => x.date === date && !x.cancelled && a < toMin(x.start) + durOf(x) + gap && b > toMin(x.start) - gap);
  };
  let pick = null, first = null;
  for (let i = 1; i <= 120 && !pick; i++) {
    const d = new Date(dateOf(last).getTime() + i * 864e5), day = dayKey(d), start = slots[weekday(d)];
    if (!start || onVacation(S, day)) continue;
    first = first || { day, start };
    if (!busy(day, start)) pick = { day, start };
  }
  pick = pick || first;
  if (!pick) return null;
  const add = { id: 's' + Math.random().toString(36).slice(2, 9), date: pick.day, start: pick.start, dur, type: s.type, kind: 'makeup',
    groupId: null, clientIds: [...s.clientIds], place: s.place || '', att: {}, log: '', next: '', cancelled: false, extOf: s.id };
  S.sessions.push(add);
  S.sessions.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return add;
}

const money = (n) => `${String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₸`;
const shortDate = (iso) => { const d = dateOf(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const RECEIPT_DAY = 20;
/** The receipts month that ends the day before `wnow`'s 20th: from the 20th of the previous month to the 19th. */
function receiptsPeriod(wnow) {
  const y = wnow.getUTCFullYear(), m = wnow.getUTCMonth();
  return { from: dayKey(new Date(Date.UTC(y, m - 1, RECEIPT_DAY))), to: dayKey(new Date(Date.UTC(y, m, RECEIPT_DAY - 1))) };
}
/** Since the last 20th up to today, for the /receipts command. */
function receiptsSoFar(wnow) {
  const y = wnow.getUTCFullYear(), m = wnow.getUTCMonth(), back = wnow.getUTCDate() < RECEIPT_DAY ? 1 : 0;
  return { from: dayKey(new Date(Date.UTC(y, m - back, RECEIPT_DAY))), to: dayKey(wnow) };
}
/**
 * Every payment dated within [from, to]: a text list with the total, and the receipt photos (JPEG/PNG/WebP only;
 * payments without a photo are listed as «без фото»). Photos keep the list number in the caption.
 * withOlder also sends photos of earlier payments that are still stored (never sent before, or a failed album).
 */
function receiptsReport(S, from, to, withOlder = false) {
  const pays = (S.payments || []).filter((p) => p.date >= from && p.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const name = (id) => S.clients.find((c) => c.id === id)?.name || 'Без клиента';
  const head = `Чеки с ${shortDate(from)} по ${shortDate(to)}`;
  const photo = (p) => /^data:image\/(jpeg|png|webp);base64,/.test(p.img || '');
  const older = withOlder ? (S.payments || []).filter((p) => p.date < from && photo(p)).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const olderPhotos = older.map((p) => ({ id: p.id, img: p.img, caption: `Раньше · ${shortDate(p.date)} · ${name(p.clientId)}${p.with ? ` и ${name(p.with)}` : ''} · ${money(p.amount)} · ${p.method || '—'}` }));
  const olderLine = older.length ? `\n\nЕщё ${older.length} фото чеков за прошлые месяцы — тоже присылаю.` : '';
  if (!pays.length) return { text: `${head}\nОплат за этот период нет.${olderLine}`, photos: olderPhotos };
  const lines = pays.map((p, i) => `${i + 1}. ${shortDate(p.date)} · ${name(p.clientId)}${p.with ? ` и ${name(p.with)}` : ''} · ${money(p.amount)} · ${p.method || '—'} · ${p.sessions} зан.${photo(p) ? '' : ' · без фото'}`);
  const total = pays.reduce((t, p) => t + (+p.amount || 0), 0), withPhoto = pays.filter(photo).length;
  return {
    text: `${head}\nВсего ${pays.length} ${pays.length % 10 === 1 && pays.length % 100 !== 11 ? 'оплата' : [2, 3, 4].includes(pays.length % 10) && ![12, 13, 14].includes(pays.length % 100) ? 'оплаты' : 'оплат'} на ${money(total)}, фото чеков: ${withPhoto}\n\n${lines.join('\n')}${olderLine}`,
    photos: [...olderPhotos, ...pays.map((p, i) => ({ p, i })).filter(({ p }) => photo(p)).map(({ p, i }) => ({ id: p.id, img: p.img, caption: lines[i] }))],
  };
}
/** Telegram limits: 4096 characters per message, 10 photos per album. */
function textChunks(text, max = 4000) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > max) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
/** sendMediaGroup bodies (FormData, at most 10 photos each) with the payment ids they carry. */
function photoForms(chatId, photos) {
  const forms = [];
  for (let i = 0; i < photos.length; i += 10) {
    const fd = new FormData(), media = [];
    photos.slice(i, i + 10).forEach((ph, j) => {
      const [, type, b64] = ph.img.match(/^data:(image\/\w+);base64,(.*)$/);
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      fd.append(`f${j}`, new Blob([bytes], { type }), `receipt${i + j + 1}.${type.split('/')[1]}`);
      media.push({ type: 'photo', media: `attach://f${j}`, caption: ph.caption.slice(0, 1000) });
    });
    fd.append('chat_id', String(chatId));
    fd.append('media', JSON.stringify(media));
    forms.push({ fd, ids: photos.slice(i, i + 10).map((ph) => ph.id) });
  }
  return forms;
}

/**
 * After the monthly report the photos live in the Telegram chat, so the service drops them to keep the data small.
 * The payment itself stays; imgSentAt tells the app where the photo went. Returns how many photos were dropped.
 */
function forgetPhotos(S, ids, day) {
  let n = 0;
  for (const p of S.payments || []) if (ids.includes(p.id) && p.img) { p.img = null; p.imgSentAt = day; n++; }
  return n;
}

/* ---------- merging after a version conflict ---------- */
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isEntityList = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');
/**
 * Three-way merge of the app state: `base` is what both sides started from, `local` has the coach's edits,
 * `remote` is what was saved meanwhile (another device, a Telegram button). What only one side changed is taken
 * from that side. Objects merge by key, lists of entities (sessions, clients, payments…) by id, so a note typed
 * in a session and an attendance mark from Telegram on the same session both survive. When both changed the same
 * value, the coach's edit wins. A deletion is applied unless the other side changed the deleted thing.
 */
function merge3(base, local, remote) {
  if (sameJSON(local, base)) return remote;
  if (sameJSON(remote, base) || sameJSON(local, remote)) return local;
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {}, out = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const inL = k in local, inR = k in remote;
      if (!inL && k in b && sameJSON(remote[k], b[k])) continue; // removed here, untouched there
      if (!inR && k in b && sameJSON(local[k], b[k])) continue; // removed there, untouched here
      out[k] = !inL ? remote[k] : !inR ? local[k] : merge3(b[k], local[k], remote[k]);
    }
    return out;
  }
  if (isEntityList(local) && isEntityList(remote)) {
    const ids = (a) => new Map((isEntityList(a) ? a : []).map((x) => [x.id, x]));
    const bm = ids(base), lm = ids(local), rm = ids(remote), out = [];
    for (const r of remote) {
      const l = lm.get(r.id), b = bm.get(r.id);
      if (l) out.push(merge3(b, l, r));
      else if (!b || !sameJSON(r, b)) out.push(r); // new there, or changed there after being removed here
    }
    for (const l of local) {
      if (rm.has(l.id)) continue;
      const b = bm.get(l.id);
      if (!b || !sameJSON(l, b)) out.push(l); // new here, or changed here after being removed there
    }
    return out;
  }
  return local;
}
/** merge3 on the whole state, then the rules a merge can break: sessions in order, one make-up per session. */
function mergeStates(base, local, remote) {
  const S = merge3(base, local, remote);
  if (Array.isArray(S?.sessions)) {
    // Both sides may have added a make-up for the same session: keep the marked one, else the first.
    const ext = new Map();
    for (const s of S.sessions) if (s.extOf) {
      const cur = ext.get(s.extOf);
      if (!cur || (!Object.keys(cur.att || {}).length && Object.keys(s.att || {}).length)) ext.set(s.extOf, s);
    }
    S.sessions = S.sessions.filter((s) => !s.extOf || ext.get(s.extOf) === s);
    S.sessions.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }
  return S;
}

/* ---------- login through the bot ---------- */
const BROWSERS = [[/YaBrowser\//, 'Яндекс Браузер'], [/Edg(e|A|iOS)?\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'], [/Chrome\/|CriOS\//, 'Chrome'], [/Safari\//, 'Safari']];
const SYSTEMS = [[/iPhone|iPad|iPod/, 'iOS'], [/Android/, 'Android'], [/CrOS/, 'ChromeOS'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'], [/Linux/, 'Linux']];
/** «Chrome, Windows» from a User-Agent string, for the coach to recognise their own device. */
function deviceOf(ua) {
  const s = String(ua || '');
  const b = BROWSERS.find(([re]) => re.test(s))?.[1] || 'неизвестный браузер';
  const o = SYSTEMS.find(([re]) => re.test(s))?.[1] || 'неизвестная система';
  return `${b}, ${o}`;
}
/** Where and when a login was asked for: «Chrome, Windows · IP 1.2.3.4 · 21 октября, 10:22». */
function loginPlace(r, tz = DEFAULT_TZ) {
  const w = wallNow(new Date(r.created_at || Date.now()), tz);
  return `${deviceOf(r.ua)} · IP ${r.ip || 'неизвестен'} · ${w.getUTCDate()} ${MONTHS[w.getUTCMonth()]}, ${hm(w)}`;
}

// A session's keys carry its date and time, so a session moved after its reminder gets one for the new time.
// The keys without them (sent before this change) still count as sent, so nothing is sent twice after the update;
// they are cleaned up with the other old keys after a few days.
const whenKey = (s) => `${s.date}T${s.start}`;
/** Messages that are due now and not yet sent, each with the key that marks it as sent. */
function dueMessages(S, wnow, wasSent, opts = {}) {
  const out = [];
  if (!Array.isArray(S?.sessions) || !Array.isArray(S?.clients)) return out;
  const leadKey = S.settings?.remindCoach || '2h', lead = (LEAD[leadKey] || 120) * 60000;
  const today = dayKey(wnow);
  // After each session: buttons to mark attendance; at 21:00 a nudge if something is still unmarked.
  if (S.settings?.tgAttendance !== false) {
    const ended = S.sessions.filter((s) => !s.cancelled && activeClients(S, s).length
      && wnow - endOf(s) >= 10 * 60000 && wnow - endOf(s) < 24 * 3600000);
    for (const s of ended) {
      const k = `att:${s.id}:${whenKey(s)}`;
      if (!wasSent(k) && !wasSent(`att:${s.id}`) && activeClients(S, s).some((id) => !s.att?.[id])) out.push({ key: k, ...attendanceView(S, s) });
    }
    const open = ended.filter((s) => activeClients(S, s).some((id) => !s.att?.[id]));
    if (hm(wnow) >= '21:00' && open.length && !wasSent(`attnudge:${today}`)) {
      out.push({ key: `attnudge:${today}`, text: `Не отмечено посещение: ${open.map((s) => `${s.start} ${titleOf(S, s)}`).join(', ')}. Кнопки — в сообщениях выше.` });
    }
  }
  // On the 20th from 09:00 (also on vacation days; caught up on the 21st–22nd if the bot was down): every receipt from the previous 20th to the 19th.
  const rk = `receipts:${today.slice(0, 7)}`;
  if (opts.receipts && S.settings?.monthlyReceipts !== false && (wnow.getUTCDate() > RECEIPT_DAY || hm(wnow) >= '09:00') && wnow.getUTCDate() >= RECEIPT_DAY && wnow.getUTCDate() <= RECEIPT_DAY + 2 && !wasSent(rk)) {
    const { from, to } = receiptsPeriod(wnow);
    out.push({ key: rk, purge: true, ...receiptsReport(S, from, to, true) });
  }
  if (onVacation(S, today)) return out;
  for (const s of S.sessions) {
    if (s.cancelled || onVacation(S, s.date) || !activeClients(S, s).length) continue;
    const st = startOf(s), key = `${s.id}:${whenKey(s)}:${leadKey}`;
    if (wnow >= st - lead && wnow < st && !wasSent(key) && !wasSent(`${s.id}:${leadKey}`)) out.push({ key, text: reminderText(S, s, wnow) });
  }
  const dk = `digest:${dayKey(wnow)}`;
  if (S.settings?.morningDigest !== false && hm(wnow) >= '07:00' && hm(wnow) < '12:00' && !wasSent(dk)) out.push({ key: dk, text: `Сводка дня\n${dayText(S, wnow)}` });
  return out;
}

globalThis.DorozhkaLogic = Object.freeze({
  merge3, mergeStates,
  prevSession, prevNote, charged, balance, pausesOf, pauseAt,
  TYPE, LEAD, DEFAULT_TZ, wallNow, startOf, dayKey, durOf, titleOf, remaining, reminderText, dayText, nextText, startText, isPaused, activeClients, attendanceView, applyAttendance, syncMakeup, RECEIPT_DAY, receiptsPeriod, receiptsSoFar, receiptsReport, textChunks, photoForms, forgetPhotos, deviceOf, loginPlace, dueMessages,
});
})();
