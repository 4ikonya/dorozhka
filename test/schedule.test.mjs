// Tests for the pure functions in shared/schedule.mjs. Run: npm test
// Times are wall-clock values in the coach's zone, kept in the UTC fields of a Date (as wallNow returns them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAttendance, dueMessages, receiptsPeriod, receiptsSoFar, remaining, syncMakeup, textChunks } from '../shared/schedule.mjs';

const at = (iso) => new Date(`${iso}Z`);
let n = 0;
const sess = (o) => ({ id: `s${++n}`, date: '2026-10-19', start: '10:00', dur: 45, type: 'individual', kind: null, groupId: null,
  clientIds: ['c1'], place: 'Дорожка 5', att: {}, log: '', next: '', cancelled: false, ...o });
const state = (o = {}) => ({
  clients: [{ id: 'c1', name: 'Аня Петрова', plan: { slots: { 0: '10:00', 2: '10:00' } } }, { id: 'c2', name: 'Борис' }],
  groups: [], sessions: [], payments: [], vacations: [],
  settings: { chargeNoShow: true, remindCoach: '2h', morningDigest: true }, ...o,
});
const pay = (o) => ({ id: `p${++n}`, clientId: 'c1', with: null, date: '2026-10-01', sessions: 8, amount: 50000, method: 'Kaspi', img: null, ...o });
const never = () => false;
const keys = (out) => out.map((m) => m.key);

/* ---------- remaining ---------- */
test('remaining: оплачено минус списанные занятия', () => {
  const S = state({
    payments: [pay({ sessions: 8 }), pay({ sessions: 1, clientId: 'c2', with: 'c1' })],
    sessions: [
      sess({ att: { c1: 'present' } }),
      sess({ att: { c1: 'absent' } }),
      sess({ att: { c1: 'excused' } }),
      sess({ att: { c1: 'present' }, kind: 'trial' }),
      sess({ att: { c1: 'present' }, cancelled: true }),
      sess(),
    ],
  });
  // 9 paid (8 + the pair payment it shares), present and absent are charged, the rest is not.
  assert.equal(remaining(S, 'c1'), 7);
});
test('remaining: «не предупредил» не списывается, если chargeNoShow выключен', () => {
  const S = state({ payments: [pay({ sessions: 2 })], sessions: [sess({ att: { c1: 'absent' } })] });
  assert.equal(remaining(S, 'c1'), 1);
  S.settings.chargeNoShow = false;
  assert.equal(remaining(S, 'c1'), 2);
});
test('remaining: долг уходит в минус', () => {
  const S = state({ sessions: [sess({ att: { c1: 'present' } })] });
  assert.equal(remaining(S, 'c1'), -1);
});

/* ---------- syncMakeup ---------- */
test('syncMakeup: все предупредили — отработка в ближайший свободный день плана после серии', () => {
  // Plan: Monday and Wednesday at 10:00. The series ends on Wednesday the 21st.
  const s = sess({ date: '2026-10-19', att: { c1: 'excused' } });
  const S = state({ sessions: [s, sess({ date: '2026-10-21' }), sess({ date: '2026-10-26', clientIds: ['c2'] })] });
  const add = syncMakeup(S, s);
  // Monday the 26th is taken by another client at the same time, so the next plan day is Wednesday the 28th.
  assert.equal(add.date, '2026-10-28');
  assert.equal(add.start, '10:00');
  assert.equal(add.kind, 'makeup');
  assert.equal(add.extOf, s.id);
  assert.equal(syncMakeup(S, s), add, 'повторный вызов не добавляет вторую отработку');
  assert.equal(S.sessions.filter((x) => x.extOf === s.id).length, 1);
});
test('syncMakeup: снятие отметки убирает неотмеченную отработку', () => {
  const s = sess({ att: { c1: 'excused' } });
  const S = state({ sessions: [s] });
  syncMakeup(S, s);
  s.att = {};
  assert.equal(syncMakeup(S, s), null);
  assert.equal(S.sessions.length, 1);
});
test('syncMakeup: отмеченная отработка остаётся', () => {
  const s = sess({ att: { c1: 'excused' } });
  const S = state({ sessions: [s] });
  const add = syncMakeup(S, s);
  add.att = { c1: 'present' };
  s.att = { c1: 'present' };
  syncMakeup(S, s);
  assert.ok(S.sessions.includes(add));
});
test('syncMakeup: группы и пробные не продлеваются', () => {
  const g = sess({ groupId: 'g1', type: 'group', att: { c1: 'excused' } });
  const t = sess({ kind: 'trial', att: { c1: 'excused' } });
  const S = state({ sessions: [g, t] });
  assert.equal(syncMakeup(S, g), null);
  assert.equal(syncMakeup(S, t), null);
  assert.equal(S.sessions.length, 2);
});
test('syncMakeup: клиент на паузе не мешает отработке, если остальные предупредили', () => {
  const S = state();
  S.clients[1].pause = { from: '2026-10-01', to: '2026-10-31' };
  const s = sess({ type: 'split', clientIds: ['c1', 'c2'], att: { c1: 'excused' } });
  S.sessions.push(s);
  assert.ok(syncMakeup(S, s));
});
test('syncMakeup: не все предупредили — отработки нет', () => {
  const s = sess({ type: 'split', clientIds: ['c1', 'c2'], att: { c1: 'excused', c2: 'present' } });
  const S = state({ sessions: [s] });
  assert.equal(syncMakeup(S, s), null);
});
test('syncMakeup: дни отпуска тренера пропускаются', () => {
  const s = sess({ date: '2026-10-19', att: { c1: 'excused' } });
  const S = state({ sessions: [s], vacations: [{ from: '2026-10-20', to: '2026-10-27' }] });
  assert.equal(syncMakeup(S, s).date, '2026-10-28');
});

/* ---------- applyAttendance ---------- */
test('applyAttendance: ставит, переключает и снимает отметку', () => {
  const s = sess();
  const S = state({ sessions: [s] });
  assert.equal(applyAttendance(S, `a|${s.id}|c1|p`), s);
  assert.equal(s.att.c1, 'present');
  applyAttendance(S, `a|${s.id}|c1|a`);
  assert.equal(s.att.c1, 'absent');
  applyAttendance(S, `a|${s.id}|c1|a`);
  assert.equal(s.att.c1, undefined);
});
test('applyAttendance: «предупредил» добавляет отработку, повторное нажатие убирает', () => {
  const s = sess();
  const S = state({ sessions: [s] });
  applyAttendance(S, `a|${s.id}|c1|e`);
  assert.equal(S.sessions.filter((x) => x.extOf === s.id).length, 1);
  applyAttendance(S, `a|${s.id}|c1|e`);
  assert.equal(S.sessions.filter((x) => x.extOf === s.id).length, 0);
});
test('applyAttendance: устаревшие и чужие данные отклоняются', () => {
  const s = sess();
  const S = state({ sessions: [s] });
  assert.equal(applyAttendance(S, 'a|nope|c1|p'), null);
  assert.equal(applyAttendance(S, `a|${s.id}|c2|p`), null);
  assert.equal(applyAttendance(S, `a|${s.id}|c1|x`), null);
  assert.equal(applyAttendance(S, `login|${s.id}|c1|p`), null);
  assert.deepEqual(s.att, {});
});

/* ---------- dueMessages ---------- */
test('dueMessages: напоминание за выбранное время до занятия, один раз', () => {
  const s = sess({ date: '2026-10-19', start: '10:00' });
  const S = state({ sessions: [s] });
  assert.deepEqual(dueMessages(S, at('2026-10-19T07:59'), never).filter((m) => !m.key.startsWith('digest')), []);
  const out = dueMessages(S, at('2026-10-19T08:00'), never).filter((m) => !m.key.startsWith('digest'));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /^Через 2 ч: 10:00 — Аня Петрова/);
  const sent = new Set(keys(out));
  assert.deepEqual(dueMessages(S, at('2026-10-19T09:30'), (k) => sent.has(k)).filter((m) => !m.key.startsWith('digest')), []);
});
test('dueMessages: нет напоминаний об отменённых занятиях и занятиях на паузе', () => {
  const S = state({ sessions: [sess({ cancelled: true }), sess({ clientIds: ['c2'] })] });
  S.clients[1].pause = { from: '2026-10-19', to: '2026-10-19' };
  assert.deepEqual(dueMessages(S, at('2026-10-19T09:00'), never).filter((m) => !m.key.startsWith('digest')), []);
});
test('dueMessages: кнопки посещения через 10 минут после конца занятия', () => {
  const s = sess({ start: '10:00', dur: 45 });
  const S = state({ sessions: [s] });
  assert.ok(!dueMessages(S, at('2026-10-19T10:54'), never).some((m) => m.reply_markup));
  const out = dueMessages(S, at('2026-10-19T10:55'), never).filter((m) => m.reply_markup);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /Отметьте посещение: 10:00/);
  assert.equal(out[0].reply_markup.inline_keyboard[0][0].callback_data, `a|${s.id}|c1|p`);
  // Marked already: no buttons. Turned off: no buttons.
  s.att = { c1: 'present' };
  assert.ok(!dueMessages(S, at('2026-10-19T11:00'), never).some((m) => m.reply_markup));
  s.att = {};
  S.settings.tgAttendance = false;
  assert.ok(!dueMessages(S, at('2026-10-19T11:00'), never).some((m) => m.reply_markup));
});
test('dueMessages: сводка дня с 7:00 до 12:00, один раз в день', () => {
  const S = state({ sessions: [sess({ start: '18:00' })], payments: [pay({ sessions: 1 })] });
  assert.ok(!keys(dueMessages(S, at('2026-10-19T06:59'), never)).includes('digest:2026-10-19'));
  const d = dueMessages(S, at('2026-10-19T07:00'), never).find((m) => m.key === 'digest:2026-10-19');
  assert.match(d.text, /^Сводка дня\nПонедельник, 19 октября\n18:00 — Аня Петрова \(Дорожка 5\)/);
  assert.match(d.text, /Нужна оплата: Аня Петрова \(осталось 1\)/);
  assert.ok(!keys(dueMessages(S, at('2026-10-19T12:00'), never)).includes('digest:2026-10-19'));
  assert.ok(!keys(dueMessages(S, at('2026-10-19T08:00'), (k) => k === 'digest:2026-10-19')).includes('digest:2026-10-19'));
  S.settings.morningDigest = false;
  assert.ok(!keys(dueMessages(S, at('2026-10-19T07:00'), never)).includes('digest:2026-10-19'));
});
test('dueMessages: в 21:00 напоминает о неотмеченных занятиях', () => {
  const S = state({ sessions: [sess({ start: '10:00' })] });
  assert.ok(!keys(dueMessages(S, at('2026-10-19T20:59'), never)).includes('attnudge:2026-10-19'));
  const m = dueMessages(S, at('2026-10-19T21:00'), never).find((x) => x.key === 'attnudge:2026-10-19');
  assert.match(m.text, /^Не отмечено посещение: 10:00 Аня Петрова/);
});
test('dueMessages: в отпуске нет напоминаний и сводки, кнопки посещения остаются', () => {
  const S = state({ sessions: [sess({ date: '2026-10-19', start: '08:00' }), sess({ date: '2026-10-19', start: '11:00' })],
    vacations: [{ from: '2026-10-19', to: '2026-10-25' }] });
  const ks = keys(dueMessages(S, at('2026-10-19T09:00'), never));
  assert.ok(!ks.some((k) => k.startsWith('digest')));
  assert.ok(!ks.some((k) => /:2h$/.test(k)));
  assert.ok(ks.some((k) => k.startsWith('att:')));
});
test('dueMessages: отчёт о чеках 20-го с 9:00 только у владельца', () => {
  const S = state({ payments: [pay({ date: '2026-10-05' })] });
  assert.ok(!keys(dueMessages(S, at('2026-10-20T09:00'), never)).includes('receipts:2026-10'));
  assert.ok(!keys(dueMessages(S, at('2026-10-20T08:59'), never, { receipts: true })).includes('receipts:2026-10'));
  const m = dueMessages(S, at('2026-10-20T09:00'), never, { receipts: true }).find((x) => x.key === 'receipts:2026-10');
  assert.match(m.text, /^Чеки с 20 сентября по 19 октября\nВсего 1 оплата/);
  assert.ok(keys(dueMessages(S, at('2026-10-22T03:00'), never, { receipts: true })).includes('receipts:2026-10'));
  assert.ok(!keys(dueMessages(S, at('2026-10-23T10:00'), never, { receipts: true })).includes('receipts:2026-10'));
});
test('dueMessages: битые данные не роняют расчёт', () => {
  assert.deepEqual(dueMessages(null, at('2026-10-19T09:00'), never), []);
  assert.deepEqual(dueMessages({ sessions: 'x' }, at('2026-10-19T09:00'), never), []);
});

/* ---------- receipts periods ---------- */
test('receiptsPeriod: с 20-го прошлого месяца по 19-е', () => {
  assert.deepEqual(receiptsPeriod(at('2026-10-20T09:00')), { from: '2026-09-20', to: '2026-10-19' });
  assert.deepEqual(receiptsPeriod(at('2026-01-20T09:00')), { from: '2025-12-20', to: '2026-01-19' });
});
test('receiptsSoFar: с последнего 20-го по сегодня', () => {
  assert.deepEqual(receiptsSoFar(at('2026-10-19T12:00')), { from: '2026-09-20', to: '2026-10-19' });
  assert.deepEqual(receiptsSoFar(at('2026-10-20T12:00')), { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(receiptsSoFar(at('2026-01-05T12:00')), { from: '2025-12-20', to: '2026-01-05' });
});

/* ---------- textChunks ---------- */
test('textChunks: режет по строкам, не длиннее предела', () => {
  assert.deepEqual(textChunks('a\nb\nc', 3), ['a\nb', 'c']);
  assert.deepEqual(textChunks('коротко'), ['коротко']);
  const long = Array.from({ length: 500 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`).join('\n');
  const parts = textChunks(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join('\n'), long);
});
