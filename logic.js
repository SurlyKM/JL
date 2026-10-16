'use strict';

/* =====================================================================
   JET LAG PLANNER: circadian logic (pure functions, no DOM, no network)

   Model in one paragraph:
   Your body clock has a daily low point in core body temperature (CBTmin),
   roughly 3 hours before your usual wake time (editable assumption).
   Light AFTER CBTmin moves the clock earlier (phase advance).
   Light BEFORE CBTmin moves the clock later (phase delay).
   Melatonin has the opposite-looking curve: taken in the afternoon or
   evening (about 11.5 h before CBTmin) it advances; taken on waking it delays.
   Travelling from Sydney (UTC+11) to PDT (UTC-7) is 18 h of difference, which
   your clock can cover as a 6 h advance OR an 18 h delay. We compare both.
   ===================================================================== */

const JL = (() => {
  const DAY = 1440, MS_MIN = 60000, MS_H = 3600000;

  // Published rates of shifting (Burgess and Eastman): hours per day.
  const RATE = { postAdv: 1.0, postDel: 1.5 };
  // Advances larger than about 8 h risk the clock shifting the wrong way.
  const ADV_LIMIT_H = 8;

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

  /* ---------- time zone helpers (built-in Intl only) ---------- */
  const dtfCache = new Map();
  function dtf(tz) {
    let f = dtfCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      dtfCache.set(tz, f);
    }
    return f;
  }
  function parts(tz, utcMs) {
    const o = {};
    for (const p of dtf(tz).formatToParts(new Date(utcMs))) {
      if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
    }
    if (o.hour === 24) o.hour = 0;
    return o;
  }
  function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }
  // Offset of tz from UTC in minutes at a given instant (handles daylight saving).
  function offsetMin(tz, utcMs) {
    const p = parts(tz, utcMs);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / MS_MIN);
  }
  // Wall clock time in tz (date + minutes after midnight) to a UTC instant.
  function wallToUtc(tz, y, mo, d, minutes) {
    const guess = Date.UTC(y, mo - 1, d, 0, 0) + minutes * MS_MIN;
    let utc = guess - offsetMin(tz, guess) * MS_MIN;
    utc = guess - offsetMin(tz, utc) * MS_MIN;
    return utc;
  }

  /* ---------- calendar helpers: a "day number" counts days since 1970 ---------- */
  const dn = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 864e5);
  const fromDn = n => {
    const t = new Date(n * 864e5);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y, m: mo, d };
  }
  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    return h < 24 && mi < 60 ? h * 60 + mi : null;
  }
  const dnIn = (tz, utcMs) => { const p = parts(tz, utcMs); return dn(p.year, p.month, p.day); };
  const minutesIn = (tz, utcMs) => { const p = parts(tz, utcMs); return p.hour * 60 + p.minute; };

  /* ---------- the daily recipe ----------
     All values are minutes on that plan-day's own clock. A plan-day starts
     with the wake-up and ends with the bedtime that leads into the NEXT
     wake-up, so bed = nextWake + 24h - sleepDuration. */
  function events(dir, wake, wakeNext, o) {
    const cbt = wake - o.cbtOff;
    const bed = wakeNext == null ? null : wakeNext + DAY - o.sleepDur;
    const ev = { wake, bed, cbt, seek: null, dim: null, mel: null, caff: null, nap: null, meals: null };
    if (dir > 0) {
      // ADVANCE: bright light from waking until 6 h after CBTmin; dim light before bed.
      ev.seek = [wake, cbt + 360];
      ev.dim = bed == null ? null : [bed - 180, bed];
      // Melatonin about 11.5 h before the CBTmin of the coming night.
      ev.mel = wakeNext == null ? null : (wakeNext - o.cbtOff) + DAY - 690;
    } else {
      // DELAY: bright light in the evening, low light for 3 h after waking, melatonin on waking.
      ev.seek = bed == null ? null : [bed - 240, bed];
      ev.dim = [wake, wake + 180];
      ev.mel = wake;
    }
    ev.caff = bed == null ? null : bed - o.caffH * 60;
    ev.nap = bed != null && bed - 540 > wake + 240 ? [wake + 240, bed - 540] : null;
    ev.meals = { b: wake + 45, l: wake + 300, d: bed == null ? null : bed - 210 };
    return ev;
  }

  /* ---------- the plan ---------- */
  function plan(inp) {
    const dep = parseDate(inp.depDate), depMin = parseTime(inp.depTime);
    const wake0 = parseTime(inp.wake), bed0 = parseTime(inp.bed);
    if (!dep || depMin === null || wake0 === null || bed0 === null) {
      return { error: 'One of the dates or times is not valid.' };
    }
    if (!validTz(inp.homeTz) || !validTz(inp.destTz)) {
      return { error: 'A time zone name was not recognised. Use names such as Australia/Sydney or America/Los_Angeles.' };
    }
    const flightH = clamp(num(inp.flightH, 14), 0.5, 72);
    const o = {
      sleepDur: mod(wake0 - bed0, DAY) || 480,
      cbtOff: clamp(num(inp.cbtOffH, 3), 1, 6) * 60,
      caffH: clamp(num(inp.caffH, 8), 4, 12)
    };
    const maxPre = clamp(num(inp.maxPreH, 4), 0, 12);
    let rate = clamp(num(inp.preRate, 0.75), 0.25, 2);
    const warn = [];

    const depUtc = wallToUtc(inp.homeTz, dep.y, dep.m, dep.d, depMin);
    const arrUtc = depUtc + flightH * MS_H;
    const diff = offsetMin(inp.homeTz, depUtc) - offsetMin(inp.destTz, arrUtc);
    const delayH = mod(diff, DAY) / 60;
    const advH = mod(-diff, DAY) / 60;
    const options = {
      advance: { hours: advH, days: advH / RATE.postAdv },
      delay: { hours: delayH, days: delayH / RATE.postDel }
    };

    let key = inp.direction;
    if (key !== 'advance' && key !== 'delay') key = advH <= ADV_LIMIT_H ? 'advance' : 'delay';
    const dir = key === 'advance' ? 1 : -1;
    const T = options[key].hours;
    const postRate = key === 'advance' ? RATE.postAdv : RATE.postDel;

    const depDn = dn(dep.y, dep.m, dep.d);
    const arrDn = dnIn(inp.destTz, arrUtc);
    const tA = minutesIn(inp.destTz, arrUtc);
    let todayDn = inp.todayDn;
    if (todayDn == null) {
      todayDn = inp.nowUtc >= arrUtc ? dnIn(inp.destTz, inp.nowUtc) : dnIn(inp.homeTz, inp.nowUtc);
    }
    const manualDir = inp.direction === 'advance' || inp.direction === 'delay';
    const base = { key, dir, T, options, warn, manualDir, depUtc, arrUtc, flightH, depDn, arrDn, tA, depMin,
      homeTz: inp.homeTz, destTz: inp.destTz, wake0, bed0, o, todayDn, advLimit: ADV_LIMIT_H,
      viewDn: inp.viewDn != null ? inp.viewDn : todayDn };
    if (T === 0) return Object.assign(base, { noShift: true, rows: [] });

    /* pre-flight shift size and rate */
    let P = Math.min(T, maxPre);
    const daysUntil = depDn - todayDn;
    if (todayDn <= depDn && P > 0) {
      if (daysUntil <= 0) {
        P = 0;
        warn.push('There are no days left before departure, so there is no pre-flight shift. The plan starts at arrival.');
      } else if (P / rate > daysUntil + 1e-9) {
        rate = P / daysUntil;
        warn.push('Only ' + daysUntil + ' days remain, so the pre-flight shift is compressed to about ' +
          (Math.round(rate * 100) / 100) + ' h per day.');
      }
    }
    const doneAt = m => (P > 0 ? clamp(P - m * rate, 0, P) : 0);
    // Keep wake and next wake on the same side of midnight so bed times stay consistent.
    const norm = (rawA, rawB) => {
      const K = DAY * Math.floor(rawA / DAY);
      return [rawA - K, rawB == null ? null : rawB - K];
    };

    const rows = [];
    if (todayDn <= depDn) {
      for (let m = daysUntil; m >= 0; m--) {
        const done = doneAt(m);
        const doneNext = m > 0 ? doneAt(m - 1) : null;
        const [wake, wakeNext] = norm(wake0 - dir * done * 60,
          doneNext === null ? null : wake0 - dir * doneNext * 60);
        const ev = events(dir, wake, wakeNext, o);
        const phase = m === 0 ? 'depart' : (done > 0 || doneNext > done) ? 'shift' : 'hold';
        if (phase === 'hold') ev.mel = null;
        rows.push(Object.assign({ kind: 'pre', phase, dn: depDn - m, m, done }, ev));
      }
    }

    /* after landing */
    const doneJ = j => (j === 0 ? P : Math.min(T, P + j * postRate));
    const rawWake = j => wake0 + dir * (T - doneJ(j)) * 60;
    const J = Math.ceil((T - P) / postRate - 1e-9) + 1;
    // mode 'local': sleep on destination clock from landing day. The body clock still
    // catches up at the normal rate, so light windows follow the body clock, not the wall clock.
    const local = inp.mode === 'local';
    for (let j = 0; j <= J; j++) {
      const done = doneJ(j), doneNext = doneJ(j + 1);
      const [wake, wakeNext] = norm(rawWake(j), rawWake(j + 1));
      const stillShifting = doneNext > done + 1e-9;
      let ev;
      if (!local) {
        ev = events(dir, wake, wakeNext, o);
      } else {
        ev = events(dir, wake0, wake0, o);           // local sleep, caffeine, meals
        // Where the body clock is today, expressed on today's local clock (within +/- 12 h of local wake).
        const off = j => mod(rawWake(j) - wake0 + 720, DAY) - 720;
        const body = events(dir, wake0 + off(j), wake0 + off(j + 1) + (off(j + 1) - off(j) > 720 ? -DAY : off(j + 1) - off(j) < -720 ? DAY : 0), o);
        ev.cbt = body.cbt;
        ev.mel = body.mel;
        if (dir > 0) {
          // Light after the body's low point advances it; light before it would push the wrong way.
          const s = Math.max(body.cbt, wake0), e = body.cbt + 360;
          ev.seek = s < e ? [s, e] : null;
          ev.avoidUntil = body.cbt > wake0 ? body.cbt : null;
        } else {
          // Delay: light in the hours before the body's low point, kept inside local waking hours.
          const s = Math.max(body.seek[0], wake0), e = Math.min(body.seek[1], ev.bed);
          ev.seek = s < e ? [s, e] : null;
          ev.dim = body.dim[1] > wake0 ? [wake0, body.dim[1]] : null;
        }
      }
      if (!stillShifting) ev.mel = null;
      let phase = stillShifting ? 'shift' : 'adapted';
      if (j === 0) {
        phase = 'arrive';
        ev.arriveMin = tA;
        if (dir > 0) {
          const s = Math.max(tA, ev.seek ? ev.seek[0] : ev.cbt), e = ev.cbt + 360;
          ev.seek = s < e ? [s, e] : null;
          ev.seekMissed = s >= e;
          ev.avoidUntil = tA < ev.cbt ? ev.cbt : null;
        } else if (ev.seek) {
          // Nothing can happen before you land: trim windows to start at landing.
          const s = Math.max(tA, ev.seek[0]);
          ev.seek = s < ev.seek[1] ? [s, ev.seek[1]] : null;
          if (ev.dim) ev.dim = ev.dim[1] > tA ? [Math.max(tA, ev.dim[0]), ev.dim[1]] : null;
        }
        ev.wake = null;
        ev.bodyWake = wake;
      }
      rows.push(Object.assign({ kind: 'post', phase, dn: arrDn + j, j, done, local }, ev));
    }

    /* flight day: where your body clock will be, in real (UTC) time */
    const bodyWakeHome = wake0 - dir * P * 60;
    const bedTod = mod(bodyWakeHome - o.sleepDur, DAY);
    const nights = [], cbts = [];
    for (let k = -1; k <= 2; k++) {
      const d = fromDn(depDn + k);
      const start = wallToUtc(inp.homeTz, d.y, d.m, d.d, bedTod);
      const end = start + o.sleepDur * MS_MIN;
      const oS = Math.max(start, depUtc), oE = Math.min(end, arrUtc);
      if (!local && oE - oS >= 20 * MS_MIN) nights.push({ start, end, oS, oE });
      const cbt = end - o.cbtOff * MS_MIN;
      if (cbt >= depUtc - 4 * MS_H && cbt <= arrUtc + 12 * MS_H) {
        const c = { utc: cbt, inFlight: cbt >= depUtc && cbt <= arrUtc };
        if (dir > 0) {
          c.avoid = [cbt - 3 * MS_H, cbt];
          c.seek = [cbt, cbt + 6 * MS_H];
          c.mel = cbt - 690 * MS_MIN;
        } else {
          c.seek = [cbt - 6 * MS_H, cbt - 3 * MS_H];
          c.avoid = [cbt, cbt + 3 * MS_H];
          c.mel = end;
        }
        cbts.push(c);
      }
    }

    if (local) {
      for (let k = -2; k <= 1; k++) {
        const d = fromDn(arrDn + k);
        const start = wallToUtc(inp.destTz, d.y, d.m, d.d, bed0);
        const end = start + o.sleepDur * MS_MIN;
        const oS = Math.max(start, depUtc), oE = Math.min(end, arrUtc);
        if (oE - oS >= 20 * MS_MIN) nights.push({ start, end, oS, oE });
      }
    }

    return Object.assign(base, { P, rate, postRate, rows, local, bodyWakeHome, nights, cbts,
      adaptedDn: (rows.find(r => r.kind === 'post' && r.phase === 'adapted') || {}).dn });
  }

  /* Which plan row matches a calendar day. */
  function pickRow(p, dnToday, nowUtc) {
    const pre = p.rows.find(r => r.kind === 'pre' && r.dn === dnToday);
    if (pre && pre.phase !== 'depart') return pre;
    if (dnToday === p.depDn) {
      if (nowUtc != null && nowUtc >= p.arrUtc) return p.rows.find(r => r.kind === 'post' && r.j === 0) || null;
      return pre || null;
    }
    return p.rows.find(r => r.kind === 'post' && r.dn === dnToday) || null;
  }

  return { plan, pickRow, parseDate, parseTime, validTz, offsetMin, wallToUtc, dn, fromDn, dnIn, mod, DAY, MS_MIN, MS_H, RATE };
})();
