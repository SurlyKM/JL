'use strict';
/* =====================================================================
   Jet lag: two pages.
   Setup: flights (lookup or manual) + usual sleep, saved on this phone.
   Plan:  day by day wake, bed and light, today first.

   Security notes:
   - The page only builds DOM with textContent/createElement (never innerHTML),
     so text from the flight API or from inputs can't become markup.
   - The CSP in index.html only allows network calls to the flight API host.
   - Data is kept in localStorage on this device only.
   ===================================================================== */

const $ = id => document.getElementById(id);
const KEY_STATE = 'jl.state.v1';
const KEY_API = 'jl.apikey.v1';
const API_HOST = 'aerodatabox.p.rapidapi.com';

/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    if (k === 'class') el.className = props[k]; else el.setAttribute(k, props[k]);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

/* ---------- storage (wrapped: private mode or blocked storage must not break the page) ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

/* ---------- airports (offline table from airports.js) ---------- */
let AIRPORT_MAP = null;
function airport(code) {
  if (!AIRPORT_MAP) {
    AIRPORT_MAP = new Map();
    for (const line of AIRPORT_ROWS.split('\n')) {
      const [c, i, city, cc] = line.split('|');
      AIRPORT_MAP.set(c, { code: c, tz: AIRPORT_TZS[+i], city, cc });
    }
  }
  return AIRPORT_MAP.get(String(code || '').trim().toUpperCase()) || null;
}

/* ---------- formatting ---------- */
const f2 = n => String(n).padStart(2, '0');
function hm(min) {
  const r = Math.round(min / 5) * 5, d = Math.floor(r / 1440), t = JL.mod(r, 1440);
  const s = f2(Math.floor(t / 60)) + ':' + f2(t % 60);
  return d === 0 ? s : s + (d > 0 ? ' +1' : ' -1');
}
const rng = a => hm(a[0]) + ' to ' + hm(a[1]);
const fmtDn = n => new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(n * 864e5));
const clock = (tz, utc) => new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(utc));
const dayClock = (tz, utc) => new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(utc));
const offStr = (tz, utc) => { const m = JL.offsetMin(tz, utc); return 'UTC' + (m < 0 ? '-' : '+') + f2(Math.floor(Math.abs(m) / 60)) + (m % 60 ? ':' + f2(Math.abs(m) % 60) : ''); };

/* ---------- state ---------- */
// Plan styles. Picking a style fills in its pre-flight settings; you can still edit them.
const STYLES = {
  gradual: { maxPreH: '4', preRate: '0.75' },
  local: { maxPreH: '2', preRate: '1' }
};
// Neutral defaults: no trip is built in, so a new user always starts at a blank setup.
const BLANK_LEG = () => ({ flight: '', date: '', from: '', dep: '', to: '', arr: '', arrDate: '' });
const freshState = () => ({ legs: [BLANK_LEG()], wake: '07:00', bed: '23:00', mode: 'gradual', ...STYLES.gradual });

// Load saved data defensively: keep every valid saved value, fill anything missing from the
// defaults (e.g. fields added in a later version), and drop anything malformed. Never throws.
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// Each saved leg field must look like what the form produces, otherwise it's dropped.
const FIELD_OK = {
  flight: v => /^[A-Z0-9 ]{0,8}$/.test(v),
  from: v => /^[A-Z]{0,3}$/.test(v), to: v => /^[A-Z]{0,3}$/.test(v),
  date: v => v === '' || !!JL.parseDate(v), arrDate: v => v === '' || !!JL.parseDate(v),
  dep: v => v === '' || JL.parseTime(v) !== null, arr: v => v === '' || JL.parseTime(v) !== null
};
function loadState() {
  let s;
  try { s = JSON.parse(store.get(KEY_STATE)); } catch (e) { return null; }
  if (!s || typeof s !== 'object' || !Array.isArray(s.legs) || !s.legs.length) return null;
  const d = freshState();
  const okTime = v => (JL.parseTime(v) !== null ? v : null);
  const okNum = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? String(n) : null; };
  const mode = s.mode === 'local' || s.mode === 'gradual' ? s.mode : 'gradual';
  const out = {
    legs: s.legs.filter(L => L && typeof L === 'object').slice(0, 6).map(L => {
      const o = BLANK_LEG();
      for (const k of Object.keys(o)) { const v = str(L[k], 12); if (FIELD_OK[k](v)) o[k] = v; }
      return o;
    }).filter(L => Object.values(L).some(Boolean)),
    wake: okTime(s.wake) || d.wake,
    bed: okTime(s.bed) || d.bed,
    mode,
    maxPreH: okNum(s.maxPreH, 0, 12) || STYLES[mode].maxPreH,
    preRate: okNum(s.preRate, 0.25, 2) || STYLES[mode].preRate
  };
  if (!out.legs.length) out.legs = [BLANK_LEG()];
  return out;
}
let state = loadState() || freshState();
const save = () => store.set(KEY_STATE, JSON.stringify(state));

/* ---------- trip from legs ---------- */
// Returns { homeTz, destTz, depUtc, arrUtc, from, to } or { error }.
function tripFromLegs(legs) {
  const out = [];
  for (let i = 0; i < legs.length; i++) {
    const L = legs[i], n = legs.length > 1 ? 'Flight ' + (i + 1) + ': ' : '';
    if (!L.from || !L.to) return { error: n + 'add the from and to airport codes, or look up the flight.' };
    const A = airport(L.from), B = airport(L.to);
    if (!A) return { error: n + 'unknown departure airport code.' };
    if (!B) return { error: n + 'unknown arrival airport code.' };
    const d = JL.parseDate(L.date), ad = JL.parseDate(L.arrDate), dt = JL.parseTime(L.dep), at = JL.parseTime(L.arr);
    if (!d || dt === null) return { error: n + 'add the departure date and time.' };
    if (!ad || at === null) return { error: n + 'add the arrival date and time.' };
    const dep = JL.wallToUtc(A.tz, d.y, d.m, d.d, dt), arr = JL.wallToUtc(B.tz, ad.y, ad.m, ad.d, at);
    if (arr <= dep) return { error: n + 'arrival is before departure. Check the arrival date.' };
    if (arr - dep > 30 * JL.MS_H) return { error: n + 'that is over 30 hours in the air. Check the dates.' };
    if (out.length && dep < out[out.length - 1].arr) return { error: n + 'departs before the previous flight lands.' };
    out.push({ A, B, dep, arr });
  }
  const first = out[0], last = out[out.length - 1];
  return { homeTz: first.A.tz, destTz: last.B.tz, depUtc: first.dep, arrUtc: last.arr, from: first.A, to: last.B };
}

function buildPlan() {
  const t = tripFromLegs(state.legs);
  if (t.error) return t;
  const depLocal = new Intl.DateTimeFormat('en-CA', { timeZone: t.homeTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t.depUtc)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const plan = JL.plan({
    homeTz: t.homeTz, destTz: t.destTz,
    depDate: depLocal.year + '-' + depLocal.month + '-' + depLocal.day,
    depTime: depLocal.hour + ':' + depLocal.minute,
    flightH: (t.arrUtc - t.depUtc) / JL.MS_H,
    wake: state.wake, bed: state.bed, direction: 'auto', mode: state.mode,
    maxPreH: state.maxPreH, preRate: state.preRate, caffH: 8, cbtOffH: 3,
    todayDn: null, nowUtc: Date.now()
  });
  plan.trip = t;
  return plan;
}

/* =====================================================================
   SETUP PAGE
   ===================================================================== */
const LEG_FIELDS = ['flight', 'date', 'from', 'dep', 'to', 'arr', 'arrDate'];

function renderLegs() {
  const box = $('legs');
  box.replaceChildren();
  state.legs.forEach((leg, i) => {
    const node = $('legTpl').content.firstElementChild.cloneNode(true);
    node.querySelector('.legtitle').textContent = state.legs.length > 1 ? 'Flight ' + (i + 1) : 'Flight';
    const rm = node.querySelector('.rm');
    rm.hidden = state.legs.length === 1;
    rm.addEventListener('click', () => { state.legs.splice(i, 1); save(); renderLegs(); });
    for (const f of LEG_FIELDS) {
      const inp = node.querySelector('.' + f);
      inp.value = leg[f] || '';
      inp.addEventListener('input', () => {
        if (inp.classList.contains('code') || f === 'flight') {
          const pos = inp.selectionStart;
          inp.value = inp.value.toUpperCase();
          try { inp.setSelectionRange(pos, pos); } catch (e) { /* some input types */ }
        }
        leg[f] = inp.value.trim();
        if (f === 'date' && !leg.arrDate) { leg.arrDate = leg.date; node.querySelector('.arrDate').value = leg.date; }
        save();
        showWhere(node, leg);
      });
    }
    node.querySelector('.lookup').addEventListener('click', () => lookup(node, leg));
    showWhere(node, leg);
    box.append(node);
  });
}

function showWhere(node, leg) {
  for (const [f, cls, timeF, dateF] of [['from', '.fromWhere', 'dep', 'date'], ['to', '.toWhere', 'arr', 'arrDate']]) {
    const el = node.querySelector(cls), a = airport(leg[f]);
    if (!leg[f]) { el.textContent = ''; continue; }
    if (!a) { el.textContent = 'Unknown code'; el.classList.add('bad'); continue; }
    el.classList.remove('bad');
    const d = JL.parseDate(leg[dateF]);
    const at = d ? Date.UTC(d.y, d.m - 1, d.d, 12) : Date.now();
    el.textContent = a.city + ', ' + a.cc + ' (' + offStr(a.tz, at) + ')';
  }
}

/* ---------- flight lookup (AeroDataBox via RapidAPI) ---------- */
const FLIGHT_RE = /^[A-Z0-9]{2}[A-Z]?\d{1,4}[A-Z]?$/;
// "2026-10-23 10:00+11:00" -> { date, time }. Anything else is rejected.
function splitLocal(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || ''));
  return m ? { date: m[1], time: m[2] } : null;
}
function iataOf(x) {
  const c = x && x.airport && x.airport.iata;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : null;
}

async function lookup(node, leg) {
  const msg = node.querySelector('.lookmsg');
  const say = (text, bad) => { msg.hidden = false; msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  const num = String(leg.flight || '').replace(/\s+/g, '').toUpperCase();
  const key = store.get(KEY_API) || $('apiKey').value.trim();
  if (!FLIGHT_RE.test(num)) return say('Enter a flight number like QF11.', true);
  if (!JL.parseDate(leg.date)) return say('Pick the departure date first.', true);
  if (!key) return say('Add your lookup key under "Flight lookup key", or fill in the airports and times below.', true);
  if (!navigator.onLine) return say('You are offline. Fill in the airports and times below instead.', true);

  say('Looking up ' + num + '...');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const url = 'https://' + API_HOST + '/flights/number/' + encodeURIComponent(num) + '/' + encodeURIComponent(leg.date) +
      '?dateLocalRole=Departure&withAircraftImage=false&withLocation=false';
    const res = await fetch(url, {
      method: 'GET', signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': API_HOST }
    });
    if (res.status === 401 || res.status === 403) return say('The lookup key was rejected. Check it, or fill in the details below.', true);
    if (res.status === 429) return say('Lookup limit reached for now. Fill in the details below.', true);
    if (res.status === 204 || res.status === 404) return say('No flight ' + num + ' found on that date. Fill in the details below.', true);
    if (!res.ok) return say('Lookup failed (' + res.status + '). Fill in the details below.', true);
    const data = await res.json();
    const f = (Array.isArray(data) ? data : [data]).find(x => x && iataOf(x.departure) && iataOf(x.arrival));
    if (!f) return say('No usable details came back. Fill in the details below.', true);
    const dl = splitLocal((f.departure.revisedTime || f.departure.scheduledTime || {}).local);
    const al = splitLocal((f.arrival.revisedTime || f.arrival.scheduledTime || {}).local);
    if (!dl || !al) return say('The times came back incomplete. Fill in the details below.', true);
    Object.assign(leg, { from: iataOf(f.departure), to: iataOf(f.arrival), date: dl.date, dep: dl.time, arrDate: al.date, arr: al.time, flight: num });
    save();
    renderLegs();
    const n2 = $('legs').children[state.legs.indexOf(leg)];
    const m2 = n2 && n2.querySelector('.lookmsg');
    if (m2) { m2.hidden = false; m2.textContent = 'Found ' + num + ': ' + leg.from + ' ' + leg.dep + ' to ' + leg.to + ' ' + leg.arr + '. Check the times match your booking.'; }
  } catch (e) {
    say(e && e.name === 'AbortError' ? 'Lookup timed out. Fill in the details below.'
      : 'Could not reach the lookup service. Fill in the details below.', true);
  } finally {
    clearTimeout(timer);
  }
}

function showStyle() {
  for (const b of document.querySelectorAll('.style')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
}
function initSetup() {
  for (const b of document.querySelectorAll('.style')) b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;  // no change, keep whatever is typed
    state.mode = b.dataset.mode;
    Object.assign(state, STYLES[state.mode]);    // switch pre-flight preset to match the style
    for (const id of ['maxPreH', 'preRate']) $(id).value = state[id];
    save(); showStyle();
  });
  showStyle();
  for (const id of ['wake', 'bed', 'maxPreH', 'preRate']) {
    $(id).value = state[id];
    $(id).addEventListener('input', () => { state[id] = $(id).value; save(); });
  }
  const k = store.get(KEY_API);
  $('apiKey').value = k ? k : '';
  $('apiKey').addEventListener('change', () => {
    const v = $('apiKey').value.trim();
    if (v) store.set(KEY_API, v); else store.del(KEY_API);
  });
  $('forgetKey').addEventListener('click', () => { store.del(KEY_API); $('apiKey').value = ''; });
  $('addLeg').addEventListener('click', () => {
    const prev = state.legs[state.legs.length - 1];
    state.legs.push(Object.assign(BLANK_LEG(), { date: prev.arrDate || prev.date || '', from: prev.to || '', arrDate: prev.arrDate || prev.date || '' }));
    save(); renderLegs();
  });
  $('go').addEventListener('click', () => {
    const p = buildPlan();
    if (p.error) { $('setupMsg').hidden = false; $('setupMsg').textContent = p.error.charAt(0).toUpperCase() + p.error.slice(1); return; }
    $('setupMsg').hidden = true;
    go('plan');
  });
  $('clearAll').addEventListener('click', () => {
    store.del(KEY_STATE); store.del(KEY_API);
    state = freshState();
    $('apiKey').value = '';
    for (const id of ['wake', 'bed', 'maxPreH', 'preRate']) $(id).value = state[id];
    showStyle(); renderLegs();
  });
  renderLegs();
}

/* =====================================================================
   PLAN PAGE
   ===================================================================== */
const PHASE = { hold: 'Usual', shift: 'Shifting', depart: 'Fly', arrive: 'Land', adapted: 'Adapted' };

// One line telling you when to get (and avoid) light.
function lightLine(r, p) {
  if (r.seekMissed) return 'Keep light low today';
  if (p.dir > 0 && r.avoidUntil != null && r.seek) return 'Sunglasses until ' + hm(r.avoidUntil) + ', then light ' + rng(r.seek);
  if (!r.seek && !r.dim) return 'No light timing needed';
  const parts = [];
  if (r.seek) parts.push('Light ' + rng(r.seek));
  if (r.dim) parts.push(p.dir > 0 ? 'dim after ' + hm(r.dim[0]) : 'low light until ' + hm(r.dim[1]));
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dayCard(r, p, opts) {
  const tz = r.kind === 'pre' ? p.homeTz : p.destTz;
  const cells = [];
  if (r.phase === 'arrive') cells.push(['Land', hm(r.arriveMin)]);
  else cells.push(['Wake', hm(r.wake)]);
  cells.push(['Bed', r.bed != null ? hm(r.bed) : 'On plane']);
  return h('article', { class: 'day ' + r.phase + (opts.today ? ' today' : '') },
    h('div', { class: 'dh' },
      h('span', { class: 'dd' }, opts.label || fmtDn(r.dn)),
      h('span', { class: 'pill ' + r.phase }, opts.today ? 'Today' : PHASE[r.phase]),
      h('span', { class: 'tz' }, cityOf(tz, p))),
    h('div', { class: 'times' }, cells.map(([k, v]) => h('div', null, h('small', null, k), h('b', null, v)))),
    h('p', { class: 'light' }, lightLine(r, p)));
}
const cityOf = (tz, p) => (tz === p.trip.from.tz ? p.trip.from.city : tz === p.trip.to.tz ? p.trip.to.city : tz);

function flightCard(p) {
  const T = p.destTz, H = p.homeTz, to = p.trip.to.city;
  const lines = [];
  lines.push(['Take off', dayClock(H, p.depUtc) + ' ' + p.trip.from.city]);
  lines.push(['Watch to', to + ' time as you board']);
  for (const n of p.nights) lines.push(['Sleep', clock(T, n.oS) + ' to ' + clock(T, n.oE) + ' ' + to + ' time']);
  for (const c of p.cbts) if (c.inFlight) {
    lines.push([p.dir > 0 ? 'Shades down' : 'Keep dark', clock(T, c.avoid[0]) + ' to ' + clock(T, c.avoid[1])]);
    lines.push(['Shades up', 'from ' + clock(T, c.seek[0])]);
  }
  lines.push(['Land', dayClock(T, p.arrUtc) + ' ' + to]);
  return h('article', { class: 'day flight' },
    h('div', { class: 'dh' }, h('span', { class: 'dd' }, 'In the air'), h('span', { class: 'pill depart' }, 'Flight')),
    h('dl', { class: 'fl' }, lines.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
}

let showPast = false;
function renderPlan() {
  const p = buildPlan();
  if (p.error) {
    fill($('planHead'), h('div', { class: 'card' }, h('p', null, p.error.charAt(0).toUpperCase() + p.error.slice(1)), h('button', { type: 'button', class: 'primary wide', id: 'fixIt' }, 'Go to setup')));
    $('fixIt').addEventListener('click', () => go('setup'));
    fill($('planToday')); fill($('planDays'));
    return;
  }
  if (p.noShift) {
    fill($('planHead'), h('div', { class: 'card' }, h('p', null, 'Same clock time at both ends. No shift needed.')));
    fill($('planToday')); fill($('planDays'));
    return;
  }
  const word = p.dir > 0 ? 'earlier' : 'later';
  const start = p.rows.find(r => r.phase === 'shift');
  fill($('planHead'),
    h('div', { class: 'route' },
      h('span', { class: 'code' }, p.trip.from.code), h('span', { class: 'arrow' }, '→'), h('span', { class: 'code' }, p.trip.to.code)),
    h('div', { class: 'facts' },
      fact(Math.round(p.T * 10) / 10 + ' h', word),
      fact(start ? fmtDn(start.dn).replace(/^\w+, /, '') : 'Now', 'start'),
      fact(p.adaptedDn ? fmtDn(p.adaptedDn).replace(/^\w+, /, '') : '-', p.local ? 'body clock caught up' : 'adapted')),
    p.warn.map(w => h('p', { class: 'msg' }, w)));

  const nowUtc = Date.now();
  const todayRow = JL.pickRow(p, p.todayDn, nowUtc);
  // Day list: hide days before today; group the run of "usual" days.
  const cards = [];
  const rows = p.rows;
  // Past = everything before today's row. With no row for today, it's either before the plan (nothing past)
  // or after it (everything past).
  const allDone = !todayRow && p.todayDn > rows[rows.length - 1].dn;
  const isPast = r => (todayRow ? rows.indexOf(r) < rows.indexOf(todayRow) : allDone);
  const past = rows.filter(isPast);
  const upcoming = rows.filter(r => !isPast(r));
  const holds = upcoming.filter(r => r.phase === 'hold' && r !== todayRow);
  let holdShown = false;
  for (const r of upcoming) {
    if (r.phase === 'hold' && r !== todayRow) {
      if (holdShown) continue;
      holdShown = true;
      const a = holds[0], b = holds[holds.length - 1];
      cards.push(dayCard(a, p, { label: holds.length > 1 ? fmtDn(a.dn) + ' to ' + fmtDn(b.dn).replace(/^\w+, /, '') : fmtDn(a.dn) }));
      continue;
    }
    cards.push(dayCard(r, p, { today: r === todayRow }));
    if (r.phase === 'depart') cards.push(flightCard(p));
  }
  fill($('planToday'));
  const pastBtn = past.length ? h('button', { type: 'button', class: 'link wide', id: 'pastBtn' }, showPast ? 'Hide past days' : 'Show ' + past.length + ' past days') : null;
  fill($('planDays'),
    allDone ? h('div', { class: 'card' }, h('p', null, 'All done. You should be on ' + p.trip.to.city + ' time.')) : null,
    pastBtn,
    showPast ? past.map(r => dayCard(r, p, {})) : null,
    cards,
    h('p', { class: 'foot' }, 'Times are local to where you are that day. Light means outdoors or a light box.'));
  if (pastBtn) pastBtn.addEventListener('click', () => { showPast = !showPast; renderPlan(); });
}
const fact = (big, small) => h('div', { class: 'fact' }, h('b', null, big), h('small', null, small));

/* =====================================================================
   NAVIGATION
   ===================================================================== */
function go(page) {
  for (const id of ['setup', 'plan']) $(id).hidden = id !== page;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-current', String(b.dataset.page === page));
  if (page === 'plan') renderPlan();
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + page); } catch (e) { /* file:// */ }
}

function init() {
  initSetup();
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => go(b.dataset.page));
  const hash = location.hash.replace('#', '');
  // Open the plan when the saved (or default) trip is valid, otherwise setup.
  go(hash === 'setup' || buildPlan().error ? 'setup' : 'plan');
  // Re-render the plan when the app comes back to the foreground on a new day.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('plan').hidden) renderPlan(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* still works online */ });
  }
}
init();
