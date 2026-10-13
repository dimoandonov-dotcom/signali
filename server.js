/* Сигнали — сутрешен доклад и дневник на проблемите.
   Събира проблемите от Обход (директно от базата му) и от Мин Макс (през API ключа),
   записва ги в дневник без повторения, всяка сутрин прави кратък доклад с Claude
   и пази кой какво е направил — основа за разпределяне на роли и автоматични уведомления.
   Всичко в един файл нарочно — по-лесно за поддръжка. */

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

/* ---------------- НАСТРОЙКИ (Railway Variables) ---------------- */
const PORT = process.env.PORT || 3000;
const OBHOD_MONGO_URI = process.env.OBHOD_MONGO_URI;           // същият MONGO_URI като на Обход
const MINMAX_URL = (process.env.MINMAX_URL || 'https://minmaxai.up.railway.app').replace(/\/$/, '');
const MINMAX_API_KEY = process.env.MINMAX_API_KEY || '';        // същият API_KEY като на Мин Макс
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const APP_PASSWORD = process.env.APP_PASSWORD || '';            // парола за вход в уеб страницата
const API_KEY = process.env.API_KEY || '';                       // за машини (бъдещо делегиране)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const REPORT_HOUR = parseInt(process.env.REPORT_HOUR_LOCAL || '7', 10);
const REPORT_MINUTE = parseInt(process.env.REPORT_MINUTE_LOCAL || '30', 10);
const STUCK_DAYS = parseInt(process.env.STUCK_DAYS || '3', 10);  // от колко поредни „НЕ“ е висящ проблем

if (!OBHOD_MONGO_URI) {
  console.error('Липсва OBHOD_MONGO_URI в Railway Variables. Спирам.');
  process.exit(1);
}

/* ---------------- БАЗА ----------------
   Ползва базата на Обход. Чете колекциите на Обход само за четене,
   а собствените данни пази в отделни колекции с префикс signali_. */
mongoose.connect(OBHOD_MONGO_URI).then(() => console.log('MongoDB свързан')).catch(e => {
  console.error('MongoDB грешка:', e.message);
  process.exit(1);
});

const loose = { strict: false };
const ObStore = mongoose.model('ObStore', new mongoose.Schema({}, loose), 'stores');
const ObPerson = mongoose.model('ObPerson', new mongoose.Schema({}, loose), 'people');
const ObAssignment = mongoose.model('ObAssignment', new mongoose.Schema({}, loose), 'assignments');
const ObVisit = mongoose.model('ObVisit', new mongoose.Schema({}, loose), 'visits');

const STATUSES = ['ново', 'възложено', 'в работа', 'решено', 'игнорирай', 'изчезна'];
const OPEN = ['ново', 'възложено', 'в работа'];

const Problem = mongoose.model('Problem', new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // източник|вид|обект|предмет — пази от повторения
  source: String,          // 'Обход' | 'Мин Макс'
  type: String,            // машинно име на вида
  typeLabel: String,       // човешко име на вида
  priority: { type: String, enum: ['висок', 'среден', 'нисък'], default: 'среден' },
  store: String,
  title: String,
  details: String,
  eur: Number,
  firstSeen: Date,
  lastSeen: Date,
  seenCount: { type: Number, default: 1 },
  streak: Number,          // за Обход: поредни „НЕ“
  status: { type: String, enum: STATUSES, default: 'ново' },
  owner: String,
  action: String,
  resolvedAt: Date,
  autoClosed: Boolean,
  history: [{ at: Date, by: String, text: String }]
}, { timestamps: true }), 'signali_problems');

const Report = mongoose.model('Report', new mongoose.Schema({
  date: { type: String, unique: true },
  text: String,
  counts: mongoose.Schema.Types.Mixed,
  warnings: [String]
}, { timestamps: true }), 'signali_reports');

const Owner = mongoose.model('Owner', new mongoose.Schema({
  ime: { type: String, required: true },
  telefon: String,
  rolia: String,           // напр. „Магазини Варна“, „Заявки НДК“
  oblasti: String,         // свободен текст: за какви проблеми отговаря
  aktiven: { type: Boolean, default: true }
}, { timestamps: true }), 'signali_owners');

/* ---------------- ПОМОЩНИ ---------------- */
function sofiaParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}
function isoAddDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// „м-н Пирин“ (Мин Макс) и „ПИРИН“ (Обход) → „ПИРИН“
const normStore = s => String(s || '?').replace(/^\s*(м-н|магазин|мн)\.?\s+/i, '').trim().toUpperCase();
const fmtBg = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '';

/* ---------------- СЪБИРАНЕ: ОБХОД ----------------
   Групирано по обект: един проблем на обект за чеклиста, за да не е шум. */
async function collectObhod(today) {
  const yesterday = isoAddDays(today, -1);
  const since = isoAddDays(today, -30);
  const out = [];
  const stores = Object.fromEntries((await ObStore.find({}, { ime: 1 }).lean()).map(s => [String(s._id), normStore(s.ime)]));
  const people = Object.fromEntries((await ObPerson.find({}, { ime: 1 }).lean()).map(p => [String(p._id), p.ime]));

  // 1) Пропуснати обходи вчера
  const missed = await ObAssignment.find({ date: yesterday, status: { $nin: ['done'] } }).lean();
  for (const a of missed) {
    const store = stores[String(a.storeId)] || '?';
    const who = people[String(a.personId || a.claimedBy)] || 'никой не го е поел';
    out.push({
      key: `obhod|missed|${store}|${yesterday}`, source: 'Обход', type: 'obhod_missed', typeLabel: 'Пропуснат обход',
      priority: 'висок', store, title: `Пропуснат обход на ${fmtBg(yesterday)}`,
      details: `По график: ${who}. Статус в графика: ${a.status}.`
    });
  }

  // 2) Чеклист — всички „НЕ“ на един обект в един проблем
  const visits = await ObVisit.find({ date: { $gte: since, $lte: today } },
    { date: 1, storeId: 1, answers: 1 }).sort({ date: 1 }).lean();
  const track = {};
  for (const v of visits) {
    const store = stores[String(v.storeId)] || '?';
    for (const a of v.answers || []) {
      if (typeof a.val !== 'boolean') continue;
      const k = store + '|' + a.pointRed + '.' + a.qIndex;
      track[k] = track[k] || { store, q: `${a.pointRed}.${a.qIndex} ${a.qText}`, h: [] };
      track[k].h.push({ date: v.date, val: a.val });
    }
  }
  const byStore = {};
  for (const t of Object.values(track)) {
    const last = t.h[t.h.length - 1];
    if (last.val !== false) continue;
    let streak = 0;
    for (let i = t.h.length - 1; i >= 0 && t.h[i].val === false; i--) streak++;
    (byStore[t.store] = byStore[t.store] || []).push({ q: t.q, streak });
  }
  for (const [store, items] of Object.entries(byStore)) {
    items.sort((a, b) => b.streak - a.streak);
    const stuck = items.filter(i => i.streak >= STUCK_DAYS);
    out.push({
      key: `obhod|checklist|${store}`, source: 'Обход', type: stuck.length ? 'obhod_stuck' : 'obhod_no',
      typeLabel: stuck.length ? 'Висящи точки по чеклиста' : 'НЕ по чеклиста',
      priority: items[0].streak >= 2 * STUCK_DAYS ? 'висок' : 'среден', store, streak: items[0].streak,
      title: `${items.length} неизпълнени точки` + (stuck.length ? `, ${stuck.length} висят ${STUCK_DAYS}+ обхода` : ''),
      details: items.slice(0, 6).map(i => `${i.q} (${i.streak}×)`).join('; ') + (items.length > 6 ? ` и още ${items.length - 6}` : '')
    });
  }

  // 3) Забележки на AI по снимките от вчера — една на обект
  const flagged = await ObVisit.find({ date: yesterday, 'photoAnalysis.flag': true },
    { date: 1, storeId: 1, personId: 1, photoAnalysis: 1 }).lean();
  for (const v of flagged) {
    const store = stores[String(v.storeId)] || '?';
    const notes = (v.photoAnalysis || []).filter(x => x && x.flag).map(x => x.summary);
    out.push({
      key: `obhod|photo|${store}|${v.date}`, source: 'Обход', type: 'obhod_photo', typeLabel: 'AI забележка по снимка',
      priority: 'среден', store, title: 'Забележка по снимките от обхода',
      details: `${people[String(v.personId)] || ''} (${fmtBg(v.date)}): ${notes.join(' / ')}`
    });
  }
  return { signals: out };
}

/* ---------------- СЪБИРАНЕ: МИН МАКС ----------------
   Групирано по обект + вид аномалия, вътре — най-скъпите артикули. */
async function mm(pathAndQuery) {
  const r = await fetch(MINMAX_URL + pathAndQuery, { headers: { 'X-API-Key': MINMAX_API_KEY },
    signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Мин Макс ${pathAndQuery}: HTTP ${r.status}`);
  return r.json();
}

const ANOMALY_PRIORITY = {
  double_delivery: 'висок', undelivered: 'висок', suspicious_delivery: 'висок', ocr_repeat: 'висок',
  negative: 'среден', shortage: 'среден', phantom: 'среден', writeoff: 'среден', correction: 'среден',
  short_delivery: 'среден', surplus: 'нисък'
};
const MIN_EUR = parseFloat(process.env.MIN_EUR || '5');      // група под тази стойност → нисък приоритет
const HIGH_EUR = parseFloat(process.env.HIGH_EUR || '30');   // недоставено над тази стойност → висок
const HIGH_LOST = parseFloat(process.env.HIGH_LOST || '20'); // свършили с пропуснати €/ден над това → висок

async function collectMinMax() {
  if (!MINMAX_API_KEY) throw new Error('Липсва MINMAX_API_KEY');
  const out = [];
  const eurAbs = r => Math.abs(typeof r.eur === 'number' ? r.eur : 0);

  // 1) Аномалии от Mistral за последните 2 дни
  const an = await mm('/ui/anomalies/list?days=2');
  const kinds = an.kinds || {};
  const groups = {};
  for (const r of an.rows || []) {
    if (r.fixed) continue; // поправените (зелените) не ни трябват
    const store = normStore(r.store);
    const k = store + '|' + r.kind;
    (groups[k] = groups[k] || { store, kind: r.kind, rows: [] }).rows.push(r);
  }
  for (const g of Object.values(groups)) {
    g.rows.sort((a, b) => eurAbs(b) - eurAbs(a));
    const eur = g.rows.reduce((s, r) => s + eurAbs(r), 0);
    const dup = g.rows.some(r => (r.docs || []).some(d => d && d.dup));
    let priority = dup ? 'висок' : (ANOMALY_PRIORITY[g.kind] || 'среден');
    // недоставена/непълна заявка е спешна само ако е за повече пари
    if (!dup && ['undelivered', 'short_delivery'].includes(g.kind)) priority = eur >= HIGH_EUR ? 'висок' : 'среден';
    if (!dup && priority !== 'висок' && eur < MIN_EUR) priority = 'нисък';
    const label = kinds[g.kind] || g.kind;
    out.push({
      key: `minmax|${g.kind}|${g.store}`, source: 'Мин Макс', type: 'mm_' + g.kind, typeLabel: label,
      priority, store: g.store, eur: +eur.toFixed(2),
      title: `${label}: ${g.rows.length} ${g.rows.length === 1 ? 'артикул' : 'артикула'}` + (eur ? `, ${eur.toFixed(2)} €` : ''),
      details: g.rows.slice(0, 5).map(r => {
        const docs = (r.docs || []).filter(d => d && d.doc).map(d => d.doc + (d.dup ? ' ДУБЛИРАН' : '')).join(', ');
        return `${r.name || r.sku || '?'}${r.day ? ' (' + r.day + ')' : ''}: ${r.qty ?? ''} бр.` +
          (r.eur ? `, ${Number(r.eur).toFixed(2)} €` : '') + (docs ? `, док. ${docs}` : '');
      }).join('; ') + (g.rows.length > 5 ? `; и още ${g.rows.length - 5}` : '')
    });
  }

  // 2) Реално свършили артикули — един проблем на обект
  const st = await mm('/ui/analytics/all/alerts?days=14&cover=1');
  const outs = {};
  for (const a of st.rows || st.alerts || []) {
    if (a.status !== 'свършил' || a.verdict !== 'реално') continue;
    const store = normStore(a.store);
    (outs[store] = outs[store] || []).push(a);
  }
  for (const [store, items] of Object.entries(outs)) {
    items.sort((a, b) => (b.rev_per_day || 0) - (a.rev_per_day || 0));
    const lost = items.reduce((s, a) => s + (a.rev_per_day || 0), 0);
    out.push({
      key: `minmax|out|${store}`, source: 'Мин Макс', type: 'mm_out', typeLabel: 'Свършили артикули',
      priority: lost >= HIGH_LOST ? 'висок' : 'среден', store, eur: +lost.toFixed(2),
      title: `${items.length} свършили артикула, губи ~${lost.toFixed(2)} €/ден`,
      details: items.slice(0, 5).map(a => `${a.name} (${a.per_day}/ден, ${a.supplier || '?'})`).join('; ') +
        (items.length > 5 ? `; и още ${items.length - 5}` : '')
    });
  }
  return { signals: out };
}

/* ---------------- ЗАПИС В ДНЕВНИКА ----------------
   Всичко с една заявка за четене и една групова за запис — базата е далеч, всяка заявка струва ~0.1 с. */
async function upsertSignals(signals, sourceName) {
  const now = new Date();
  const today = sofiaParts(now).date;
  const existing = new Map((await Problem.find({ source: sourceName },
    { key: 1, status: 1, lastSeen: 1, history: { $slice: -3 } }).lean()).map(p => [p.key, p]));
  const ops = [];
  let added = 0, repeated = 0, closed = 0;
  const seenKeys = new Set();
  for (const s of signals) {
    if (seenKeys.has(s.key)) continue;
    seenKeys.add(s.key);
    const ex = existing.get(s.key);
    if (!ex) {
      ops.push({ insertOne: { document: { ...s, firstSeen: now, lastSeen: now, seenCount: 1, status: 'ново',
        history: [{ at: now, by: 'Сигнали', text: 'Нов сигнал' }] } } });
      added++;
      continue;
    }
    const set = { lastSeen: now, title: s.title, details: s.details, priority: s.priority, type: s.type,
      typeLabel: s.typeLabel, streak: s.streak, eur: s.eur };
    const update = { $set: set };
    // „видян пак“ се брои веднъж на ден, не при всяко ръчно пускане
    if (sofiaParts(ex.lastSeen).date !== today) update.$inc = { seenCount: 1 };
    // затворен, но се появява пак → отваряме наново
    if (!OPEN.includes(ex.status) && ex.status !== 'игнорирай') {
      Object.assign(set, { status: 'ново', resolvedAt: null, autoClosed: false });
      update.$push = { history: { at: now, by: 'Сигнали', text: 'Появи се отново' } };
    }
    ops.push({ updateOne: { filter: { _id: ex._id }, update } });
    repeated++;
  }
  // Изчезнали: новите и невъзложените се затварят сами; възложените само се отбелязват
  for (const p of existing.values()) {
    if (seenKeys.has(p.key) || !OPEN.includes(p.status)) continue;
    const isChecklist = p.key.startsWith('obhod|checklist|');
    const text = isChecklist ? 'Последният обход е „ДА“ по всички точки — изглежда оправено' : 'Сигналът вече не се появява';
    if (p.status === 'ново') {
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { status: isChecklist ? 'решено' : 'изчезна',
        resolvedAt: now, autoClosed: true }, $push: { history: { at: now, by: 'Сигнали', text } } } } });
      closed++;
    } else if (!(p.history || []).some(h => h.text === text && now - new Date(h.at) < 20 * 3600e3)) {
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $push: { history: { at: now, by: 'Сигнали', text } } } } });
    }
  }
  if (ops.length) await Problem.bulkWrite(ops, { ordered: false });
  return { added, repeated, closed };
}

/* ---------------- СУТРЕШЕН ДОКЛАД ---------------- */
async function aiSummary(problems, date) {
  if (!ANTHROPIC_API_KEY) return null;
  const lines = problems.slice(0, 120).map(p =>
    `[${p.priority}] ${p.source} · ${p.typeLabel} · ${p.store || ''} · ${p.title} — ${p.details || ''}` +
    (p.seenCount > 1 ? ` (вижда се ${p.seenCount}-и път)` : ' (НОВ)') + (p.owner ? ` · отговорник: ${p.owner}` : ''));
  const prompt = `Ти си оперативен анализатор на верига магазини и дистрибуция. Днес е ${date}.
По-долу са отворените проблеми от системите Обход (обходи на магазини) и Мин Макс (наличности и заявки).

${lines.join('\n') || '(няма отворени проблеми)'}

Напиши сутрешен доклад на български за собственика, който ще го прочете за минута:
1. Едно изречение: общо как е.
2. „Спешно днес“ — до 5 точки: кое, къде, защо е важно и какво да се направи. Започни с новите и с тези с висок приоритет.
3. „Повтарящи се“ — проблеми, които се виждат пак и пак или са в няколко обекта (това са кандидати за правило или за отговорник).
4. „Може да почака“ — едно изречение.
Без увод, без таблици, кратко и конкретно. Ако няма нищо важно, кажи го направо.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 8000, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('AI: ' + (d.error?.message || r.status));
  const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('').trim();
  if (!text) throw new Error(`AI върна празен отговор (stop: ${d.stop_reason}, блокове: ${(d.content || []).map(c => c.type).join(',')})`);
  return text;
}

let running = false;
async function runAll(trigger = 'ръчно') {
  if (running) return { busy: true };
  running = true;
  const { date } = sofiaParts();
  const errors = [];
  const counts = {};
  try {
    try {
      const ob = await collectObhod(date);
      counts.obhod = await upsertSignals(ob.signals, 'Обход');
    } catch (e) { errors.push('Обход: ' + e.message); console.error(e); }
    try {
      const mmres = await collectMinMax();
      counts.minmax = await upsertSignals(mmres.signals, 'Мин Макс');
    } catch (e) { errors.push('Мин Макс: ' + e.message); console.error(e); }

    const open = await Problem.find({ status: { $in: OPEN } }).lean();
    const prio = { 'висок': 0, 'среден': 1, 'нисък': 2 };
    open.sort((a, b) => (prio[a.priority] - prio[b.priority]) || (a.seenCount - b.seenCount));
    counts.open = open.length;
    counts.high = open.filter(p => p.priority === 'висок').length;
    counts.new = open.filter(p => p.status === 'ново' && p.seenCount === 1).length;
    let text = null;
    try { text = await aiSummary(open, date); } catch (e) { errors.push(e.message); }
    if (!text) text = `Отворени проблеми: ${counts.open} (висок приоритет: ${counts.high}, нови: ${counts.new}).`;
    await Report.findOneAndUpdate({ date }, { date, text, counts, warnings: errors }, { upsert: true });
    console.log(`Сигнали (${trigger}) за ${date}:`, JSON.stringify(counts), errors.join(' | '));
    return { ok: true, date, counts, errors };
  } finally { running = false; }
}

// Автоматично всяка сутрин в REPORT_HOUR:REPORT_MINUTE българско време
let lastAutoRun = null;
setInterval(() => {
  const { date, hour, minute } = sofiaParts();
  if (hour === REPORT_HOUR && minute >= REPORT_MINUTE && lastAutoRun !== date) {
    lastAutoRun = date;
    runAll('автоматично').catch(e => console.error('Грешка при сутрешния доклад:', e.message));
  }
}, 60 * 1000);

/* ---------------- ВХОД ---------------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
// грешка в един маршрут не трябва да сваля целия сървър
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
process.on('unhandledRejection', e => console.error('Необработена грешка:', e && e.message));

const sessionToken = () => crypto.createHmac('sha256', SESSION_SECRET).update('signali:' + APP_PASSWORD).digest('hex');
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function authed(req) {
  if (!APP_PASSWORD && !API_KEY) return true; // без пароли — само за първоначален тест
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return true;
  const c = cookie(req, 'signali');
  return !!APP_PASSWORD && c.length === 64 && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sessionToken()));
}
app.post('/api/login', (req, res) => {
  const pw = String((req.body || {}).password || '');
  if (!APP_PASSWORD || pw !== APP_PASSWORD) return res.status(401).json({ error: 'Грешна парола' });
  res.setHeader('Set-Cookie', `signali=${sessionToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${180 * 86400}`);
  res.json({ ok: true });
});
app.get('/health', (req, res) => res.json({ ok: true, ai: !!ANTHROPIC_API_KEY, aiKeyLen: ANTHROPIC_API_KEY.length,
  minmax: !!MINMAX_API_KEY, model: AI_MODEL, running }));
app.use('/api', (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Няма вход' }));

/* ---------------- API ---------------- */
// Сутрешен доклад (последният или за дата)
app.get('/api/report', wrap(async (req, res) => {
  const q = req.query.date ? { date: req.query.date } : {};
  res.json(await Report.findOne(q).sort({ date: -1 }).lean());
}));
app.post('/api/run', wrap(async (req, res) => res.json(await runAll('ръчно'))));
app.post('/api/admin/reset', wrap(async (req, res) => {
  const assigned = await Problem.countDocuments({ $or: [{ owner: { $nin: [null, ''] } }, { status: { $in: ['възложено', 'в работа', 'решено'] }, autoClosed: { $ne: true } }] });
  if (assigned && req.query.force !== '1') return res.status(400).json({ error: `Има ${assigned} възложени/обработени — не трия` });
  const p = await Problem.deleteMany({}); const r = await Report.deleteMany({});
  res.json({ ok: true, problems: p.deletedCount, reports: r.deletedCount });
}));

// Дневник на проблемите — с филтри. Това е и входът за бъдещо делегиране.
app.get('/api/problems', wrap(async (req, res) => {
  const { status, source, owner, store, type, q } = req.query;
  const f = {};
  if (status === 'open') f.status = { $in: OPEN };
  else if (status) f.status = status;
  if (source) f.source = source;
  if (owner) f.owner = owner;
  if (store) f.store = store;
  if (type) f.type = type;
  if (q) f.$or = ['title', 'details', 'store'].map(k => ({ [k]: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }));
  const rows = await Problem.find(f).sort({ lastSeen: -1 }).limit(500).lean();
  const prio = { 'висок': 0, 'среден': 1, 'нисък': 2 };
  rows.sort((a, b) => (OPEN.includes(b.status) - OPEN.includes(a.status)) || (prio[a.priority] - prio[b.priority]));
  res.json(rows);
}));

app.patch('/api/problems/:id', wrap(async (req, res) => {
  const { status, owner, action, priority, by } = req.body || {};
  const p = await Problem.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Няма такъв проблем' });
  const notes = [];
  if (owner !== undefined && owner !== p.owner) {
    notes.push(owner ? `Възложено на ${owner}` : 'Махнат отговорник');
    p.owner = owner;
    if (owner && p.status === 'ново' && !status) p.status = 'възложено';
  }
  if (status && status !== p.status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Невалиден статус' });
    notes.push(`Статус: ${status}`);
    p.status = status;
    p.resolvedAt = ['решено', 'игнорирай'].includes(status) ? new Date() : null;
    p.autoClosed = false;
  }
  if (priority && priority !== p.priority) { notes.push(`Приоритет: ${priority}`); p.priority = priority; }
  if (action !== undefined && action !== p.action) { notes.push(`Действие: ${action}`); p.action = action; }
  if (notes.length) p.history.push({ at: new Date(), by: by || 'Димо', text: notes.join('; ') });
  await p.save();
  res.json(p);
}));

// Отговорници (за възлагане сега и автоматично уведомяване после)
app.get('/api/owners', wrap(async (req, res) => res.json(await Owner.find().sort({ ime: 1 }).lean())));
app.post('/api/owners', wrap(async (req, res) => {
  const { ime, telefon, rolia, oblasti } = req.body || {};
  if (!ime) return res.status(400).json({ error: 'Името е задължително' });
  res.json(await Owner.create({ ime, telefon, rolia, oblasti }));
}));
app.put('/api/owners/:id', wrap(async (req, res) =>
  res.json(await Owner.findByIdAndUpdate(req.params.id, req.body || {}, { new: true }))));
app.delete('/api/owners/:id', wrap(async (req, res) => { await Owner.findByIdAndDelete(req.params.id); res.json({ ok: true }); }));

// Статистика за последните N дни — от нея ще излязат правилата „ако Х → уведоми Y“
app.get('/api/stats', wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 180);
  const since = new Date(Date.now() - days * 86400e3);
  const rows = await Problem.find({ lastSeen: { $gte: since } }).lean();
  const by = (fn) => {
    const m = {};
    for (const r of rows) { const k = fn(r) || '—'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
  };
  const resolved = rows.filter(r => r.resolvedAt && !r.autoClosed && r.status === 'решено');
  const avgH = resolved.length ? resolved.reduce((s, r) => s + (new Date(r.resolvedAt) - new Date(r.firstSeen)), 0) / resolved.length / 3600e3 : null;
  const ownerType = {};
  for (const r of rows.filter(r => r.owner)) {
    const k = r.typeLabel + ' → ' + r.owner;
    ownerType[k] = (ownerType[k] || 0) + 1;
  }
  res.json({
    days, total: rows.length, open: rows.filter(r => OPEN.includes(r.status)).length,
    resolvedByHand: resolved.length, avgHoursToResolve: avgH ? +avgH.toFixed(1) : null,
    byType: by(r => r.typeLabel), byStore: by(r => r.store).slice(0, 15), byOwner: by(r => r.owner),
    repeating: rows.filter(r => r.seenCount >= 3).sort((a, b) => b.seenCount - a.seenCount).slice(0, 15)
      .map(r => ({ store: r.store, title: r.title, type: r.typeLabel, seen: r.seenCount, status: r.status })),
    // кой вид проблем на кого се възлага — кандидати за автоматично правило
    ruleCandidates: Object.entries(ownerType).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }))
  });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error('Грешка:', err.message); res.status(500).json({ error: err.message }); });

app.listen(PORT, () => console.log('Сигнали слуша на порт ' + PORT));
