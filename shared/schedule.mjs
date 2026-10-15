// Reminder logic shared by the laptop server and the cloud function: pure functions over the app state.
// All times are "wall clock" values in the coach's time zone, stored in the UTC fields of a Date.

export const TYPE = { baby: 'Грудничковое', individual: 'Индивидуальное', split: 'Сплит', minigroup: 'Мини-группа', group: 'Групповое' };
export const LEAD = { '30m': 30, '2h': 120, '1d': 1440 };
const KIND = { trial: 'Пробное ', makeup: 'Отработка ' };
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = (n) => String(n).padStart(2, '0');

export const DEFAULT_TZ = 'Asia/Almaty';
export function wallNow(now, tz) {
  if (!tz) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()));
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return tz === DEFAULT_TZ ? wallNow(now) : wallNow(now, DEFAULT_TZ); }
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
export const startOf = (s) => {
  const [y, m, d] = s.date.split('-').map(Number);
  const [h, mi] = s.start.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi));
};
export const dayKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const durOf = (s) => s.dur || (s.type === 'baby' ? 30 : 45);
const endOf = (s) => startOf(s).getTime() + durOf(s) * 60000;
const hm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const byStart = (a, b) => startOf(a) - startOf(b);

export function titleOf(S, s) {
  const name = s.groupId
    ? (S.groups.find((g) => g.id === s.groupId)?.name || 'Группа').split(' ·')[0]
    : s.clientIds.map((id) => S.clients.find((c) => c.id === id)?.name || '—').join(', ');
  return (KIND[s.kind] || '') + name;
}
function prevNote(S, s) {
  const t = startOf(s);
  const same = (x) => (s.groupId ? x.groupId === s.groupId : !x.groupId && x.clientIds[0] === s.clientIds[0]);
  return S.sessions.filter((x) => x.id !== s.id && same(x) && startOf(x) < t && x.next).sort(byStart).pop()?.next || '';
}
export function remaining(S, cid) {
  const charged = (a) => a === 'present' || (a === 'absent' && S.settings?.chargeNoShow !== false);
  let used = 0;
  for (const s of S.sessions) if (!s.cancelled && s.clientIds.includes(cid) && charged(s.att?.[cid])) used++;
  return S.payments.filter((p) => p.clientId === cid || p.with === cid).reduce((t, p) => t + p.sessions, 0) - used;
}
function needPayment(S, wnow) {
  return S.clients.filter((c) => {
    const up = S.sessions.filter((s) => !s.cancelled && s.clientIds.includes(c.id) && !isPaused(c, s.date) && !s.att?.[c.id] && startOf(s) > wnow);
    return up.length && !up.every((s) => s.kind === 'trial') && remaining(S, c.id) <= 1;
  }).map((c) => `${c.name} (осталось ${remaining(S, c.id)})`);
}
function inText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `Через ${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  return h < 24 ? `Через ${h} ч${mm ? ` ${mm} мин` : ''}` : 'Завтра';
}
export function reminderText(S, s, wnow) {
  const note = prevNote(S, s);
  return `${inText(startOf(s) - wnow)}: ${s.start} — ${titleOf(S, s)}\n${TYPE[s.type] || ''}, ${s.place}${note ? `\nС прошлого раза: ${note}` : ''}`;
}
export function dayText(S, wnow) {
  const today = S.sessions.filter((s) => !s.cancelled && s.date === dayKey(wnow) && activeClients(S, s).length).sort(byStart);
  const day = DAYS[wnow.getUTCDay()];
  const head = `${day[0].toUpperCase()}${day.slice(1)}, ${wnow.getUTCDate()} ${MONTHS[wnow.getUTCMonth()]}`;
  const list = today.length ? today.map((s) => `${s.start} — ${titleOf(S, s)} (${s.place})`).join('\n') : 'Занятий нет';
  const pay = needPayment(S, wnow);
  return `${head}\n${list}${pay.length ? `\n\nНужна оплата: ${pay.join(', ')}` : ''}`;
}
export function nextText(S, wnow) {
  const next = S.sessions.filter((s) => !s.cancelled && activeClients(S, s).length && startOf(s) > wnow).sort(byStart)[0];
  return next ? reminderText(S, next, wnow) : 'Ближайших занятий нет.';
}
export function startText(S) {
  const lead = LEAD[S?.settings?.remindCoach || '2h'] || 120;
  return `Готово. Буду напоминать о занятиях за ${lead >= 60 ? `${lead / 60} ч` : `${lead} мин`} и присылать сводку дня в 7:00.\nКоманды: /today — занятия на сегодня, /next — ближайшее.`;
}
// c.pause is the current or next pause; c.pauses keeps the finished ones (same as the app).
export const isPaused = (c, date) => [...(c?.pauses || []), ...(c?.pause ? [c.pause] : [])].some((p) => p.from <= date && date <= p.to);
const onVacation = (S, date) => (S.vacations || []).some((v) => v.from <= date && date <= v.to);
/** Clients expected at the session: everyone not on pause that day. */
export const activeClients = (S, s) => s.clientIds.filter((id) => !isPaused(S.clients.find((c) => c.id === id), s.date));

const ATT_LABEL = { present: 'был', absent: 'не предупредил', excused: 'предупредил' };
const ATT_CODE = { p: 'present', a: 'absent', e: 'excused' };
export function attendanceView(S, s) {
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
  return {
    text: `${done ? 'Отмечено' : 'Отметьте посещение'}: ${s.start} — ${titleOf(S, s)}\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}
/** Applies a button press "a|session|client|p|a|e". Returns the session, or null if the data is stale. */
export function applyAttendance(S, data) {
  const [kind, sid, cid, code] = String(data).split('|');
  const s = S.sessions.find((x) => x.id === sid);
  if (kind !== 'a' || !s || !s.clientIds.includes(cid) || !ATT_CODE[code]) return null;
  s.att = s.att || {};
  if (s.att[cid] === ATT_CODE[code]) delete s.att[cid]; else s.att[cid] = ATT_CODE[code];
  return s;
}

/** Messages that are due now and not yet sent, each with the key that marks it as sent. */
export function dueMessages(S, wnow, wasSent) {
  const out = [];
  if (!Array.isArray(S?.sessions) || !Array.isArray(S?.clients)) return out;
  const leadKey = S.settings?.remindCoach || '2h', lead = (LEAD[leadKey] || 120) * 60000;
  const today = dayKey(wnow);
  // After each session: buttons to mark attendance; at 21:00 a nudge if something is still unmarked.
  if (S.settings?.tgAttendance !== false) {
    const ended = S.sessions.filter((s) => !s.cancelled && activeClients(S, s).length
      && wnow - endOf(s) >= 10 * 60000 && wnow - endOf(s) < 24 * 3600000);
    for (const s of ended) {
      const k = `att:${s.id}`;
      if (!wasSent(k) && activeClients(S, s).some((id) => !s.att?.[id])) out.push({ key: k, ...attendanceView(S, s) });
    }
    const open = ended.filter((s) => activeClients(S, s).some((id) => !s.att?.[id]));
    if (hm(wnow) >= '21:00' && open.length && !wasSent(`attnudge:${today}`)) {
      out.push({ key: `attnudge:${today}`, text: `Не отмечено посещение: ${open.map((s) => `${s.start} ${titleOf(S, s)}`).join(', ')}. Кнопки — в сообщениях выше.` });
    }
  }
  if (onVacation(S, today)) return out;
  for (const s of S.sessions) {
    if (s.cancelled || onVacation(S, s.date) || !activeClients(S, s).length) continue;
    const st = startOf(s), key = `${s.id}:${leadKey}`;
    if (wnow >= st - lead && wnow < st && !wasSent(key)) out.push({ key, text: reminderText(S, s, wnow) });
  }
  const dk = `digest:${dayKey(wnow)}`;
  if (S.settings?.morningDigest !== false && hm(wnow) >= '07:00' && hm(wnow) < '12:00' && !wasSent(dk)) out.push({ key: dk, text: `Сводка дня\n${dayText(S, wnow)}` });
  return out;
}
