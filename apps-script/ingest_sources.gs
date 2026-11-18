/**
 * Pulls the numbers from the source spreadsheets into the task tabs of the master spreadsheet.
 * Uses toNum_ and CFG from consolidate_main_data.gs: both files live in the SAME Apps Script project.
 *
 * 1) previewIngest(): dry run; writes the result to "Ingestion Log" (writes no data).
 * 2) If the log looks right, run runDaily() (ingests, then consolidates).
 * 3) installDailyIngestTrigger(): schedules a run every day between 6:00 and 7:00 (replaces older triggers).
 * If a run hits the 6-minute limit, run it again: the script is idempotent.
 */

// Agents based in Brazil; anyone not listed is treated as China (same rule as the spreadsheet).
// Only used when the country column of the destination tab has no rule formula to copy.
const BR_AGENTS = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Felipe', 'Gabriela', 'Henrique',
  'Isabela', 'João', 'Larissa', 'Marcos'];

// false = existing rows are only updated inside the UPDATE_RECENT_DAYS window;
// older rows are preserved (manual edits). true = any existing row may be updated.
const UPDATE_EXISTING = false;
// Rows from the last N days (today excluded) are refreshed from the source on every run, to pick up
// numbers filled in after the morning run. Manual edits on those days are overwritten.
// 0 = off (never update an existing row).
const UPDATE_RECENT_DAYS = 3;
// true = never insert or update today's rows (the day may be incomplete); they come in on the next run.
const SKIP_TODAY = true;
// Only insert days from the last N days (0 = no limit). Safety net against day/month typed in the wrong
// order at the source: those rows are left out and show up as SKIP in the Ingestion Log.
// For a historical backfill of a new source, set it to 0 temporarily.
const LOOKBACK_DAYS = 45;
// Hour (project time zone) when the daily trigger fires: between 6:00 and 7:00.
const DAILY_HOUR = 6;

/**
 * cols: source header names, in lowercase. up/notUp are optional.
 * headerRow: header row in the source (default 1).
 * numFmt: 'en' when the source uses a comma as thousands separator (7,797); default is a dot (7.797).
 * dateFromDisplay: true reads the date as displayed (dd/mm/yyyy). Use it when the source sheet is set to
 *   the en_US locale and the team types dd/mm: Sheets silently turns 03/11 into March 11.
 * assignedFromSource: false when the source has NO assigned-items column. On existing rows the assigned
 *   value in the tab is preserved (only "done" is updated); on new rows, assigned = done (assumption).
 */
const SOURCES = [
  {
    name: 'T1', dest: 'T1 - Categorization (Front End)',
    sourceId: 'YOUR_T1_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    headerRow: 2, numFmt: 'en',
    cols: { user: 'name', date: 'date', assigned: 'assign', done: 'completion' }
  },
  {
    name: 'T2', dest: 'T2 - Image Optimisation',
    sourceId: 'YOUR_T2_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    cols: { user: 'nick name', date: 'finish', assigned: 'assigned', done: 'items done', up: 'uploaded', notUp: 'not uploaded' }
  },
  {
    // The source has no assigned-items column.
    name: 'T3', dest: 'T3 - Weight&Volumes', assignedFromSource: false,
    sourceId: 'YOUR_T3_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    cols: { user: 'nick name', date: 'finish', assigned: 'completion', done: 'completion' }
  },
  {
    // Same as T3: the source has no assigned-items column.
    name: 'T4', dest: 'T4 - CPG Brand', assignedFromSource: false,
    sourceId: 'YOUR_T4_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    cols: { user: 'nick name', date: 'finish', assigned: 'completion', done: 'completion' }
  },
  {
    name: 'Frontend', dest: 'Frontend Category', dateFromDisplay: true,
    sourceId: 'YOUR_FRONTEND_SOURCE_SHEET_ID', sourceTab: 'Control',
    cols: { user: 'user', date: 'date', assigned: 'items_assigned', done: 'items_done' }
  },
  {
    name: 'Backend', dest: 'Backend Category', dateFromDisplay: true,
    sourceId: 'YOUR_BACKEND_SOURCE_SHEET_ID', sourceTab: 'Control',
    cols: { user: 'user', date: 'date', assigned: 'items_assigned', done: 'items_done' }
  },
  {
    name: 'Special Tag', dest: 'Special Tag',
    sourceId: 'YOUR_SPECIAL_TAG_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    cols: { user: 'assignee', date: 'date', assigned: 'assigned tasks', done: 'completion' }
  }
];
const INGEST_LOG = 'Ingestion Log';

/**
 * Daily run: ingests, consolidates and records when it ran (read by webapp.gs).
 * If a source fails, the others still run and Main Data is consolidated anyway; the status becomes
 * "partial" and the error is re-thrown at the end so Apps Script sends its failure e-mail.
 */
function runDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another run is still in progress');
  const props = PropertiesService.getScriptProperties();
  try {
    const errors = ingestAll(false);
    consolidate();
    props.setProperties({
      lastRun: new Date().toISOString(),
      lastStatus: errors.length ? 'partial: ' + errors.join('; ') : 'ok'
    });
    if (errors.length) throw new Error('Ingestion errors: ' + errors.join('; '));
  } catch (e) {
    if (!/^Ingestion errors/.test(String(e.message))) {
      props.setProperties({ lastRun: new Date().toISOString(), lastStatus: 'failed: ' + e.message });
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function previewIngest() {
  ingestAll(true);
}

/** Deletes older triggers (consolidate, runWeekly, runDaily) and creates one daily trigger, 6:00-7:00. */
function installDailyIngestTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['consolidate', 'runWeekly', 'runDaily'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(DAILY_HOUR).create();
}

/** Returns the list of sources that failed (empty when everything went fine). */
function ingestAll(dry) {
  const now = new Date(), log = [], errors = [];
  SOURCES.forEach(s => {
    try { ingestOne_(s, !!dry, log, now); }
    catch (e) { log.push([now, s.name, 'ERROR', String(e)]); errors.push(s.name + ': ' + e.message); }
  });
  appendLog_(log);
  return errors;
}

function ingestOne_(s, dry, log, now) {
  // ---- source ----
  const srcSS = SpreadsheetApp.openById(s.sourceId);
  const srcTz = srcSS.getSpreadsheetTimeZone();                       // source dates: SOURCE time zone
  const destTz = SpreadsheetApp.getActive().getSpreadsheetTimeZone(); // written dates: DESTINATION time zone
  const src = srcSS.getSheetByName(s.sourceTab);
  if (!src) throw new Error('Source tab not found: ' + s.sourceTab);
  const v = src.getDataRange().getValues();
  const vd = s.dateFromDisplay ? src.getDataRange().getDisplayValues() : null;
  const hr = (s.headerRow || 1) - 1;
  if (v.length <= hr + 1) throw new Error('Source tab has no data rows');
  const h = v[hr].map(x => String(x).trim().toLowerCase());
  const ix = {};
  Object.keys(s.cols).forEach(k => {
    ix[k] = h.indexOf(s.cols[k]);
    if (ix[k] < 0) throw new Error('Column not found in source: ' + s.cols[k]);
  });
  const hasUp = !!s.cols.up && !!s.cols.notUp;
  const num = x => numOf_(x, s.numFmt);

  // sum repeated rows of the same agent on the same day
  const agg = {};
  for (let i = hr + 1; i < v.length; i++) {
    const r = v[i];
    const user = String(r[ix.user]).trim();
    if (!user && !r[ix.date]) continue;
    const dt = ymd_(vd ? vd[i][ix.date] : r[ix.date], srcTz);
    if (!user || !dt) {
      log.push([now, s.name, 'SKIP', 'source row ' + (i + 1) + ': missing user or unreadable date (' + r[ix.date] + ')']);
      continue;
    }
    const key = norm_(user) + '|' + dt;
    const a = agg[key] || (agg[key] = { user: user, dt: dt, as: 0, dn: 0, up: 0, nu: 0 });
    a.as += num(r[ix.assigned]);
    a.dn += num(r[ix.done]);
    if (hasUp) { a.up += num(r[ix.up]); a.nu += num(r[ix.notUp]); }
  }

  // ---- destination ----
  const ds = SpreadsheetApp.getActive().getSheetByName(s.dest);
  if (!ds) throw new Error('Destination tab not found: ' + s.dest);
  const dv = ds.getDataRange().getValues();
  const dh = dv[0].map(x => String(x).trim().toLowerCase());
  const dc = {
    country: dh.indexOf('country'), user: dh.indexOf('user'), date: dh.indexOf('date'),
    as: dh.indexOf('items_assigned'), dn: dh.indexOf('items_done'),
    pct: dh.indexOf('items_done_%'), up: dh.indexOf('uploaded'), nu: dh.indexOf('not uploaded')
  };
  ['country', 'user', 'date', 'as', 'dn'].forEach(k => {
    if (dc[k] < 0) throw new Error('Column not found in destination: ' + k);
  });
  const doUp = hasUp && dc.up >= 0 && dc.nu >= 0;
  const keepAs = s.assignedFromSource === false; // keep the assigned value already in the tab

  const rowOf = {}, canon = {};
  let last = 1;
  for (let i = 1; i < dv.length; i++) {
    const r = dv[i];
    const u = String(r[dc.user]).trim();
    if (!u) continue;
    last = i + 1;
    if (!canon[norm_(u)]) canon[norm_(u)] = u; // spelling already used in the tab (e.g. Cátia vs Catia)
    const d = ymd_(r[dc.date], destTz);
    if (d) rowOf[norm_(u) + '|' + d] = i + 1;
  }

  let upd = 0, kept = 0, openDay = 0, tooOld = 0;
  const today = Utilities.formatDate(new Date(), destTz, 'yyyy-MM-dd');
  const cutoff = LOOKBACK_DAYS > 0
    ? Utilities.formatDate(new Date(Date.now() - LOOKBACK_DAYS * 864e5), destTz, 'yyyy-MM-dd') : '0000-00-00';
  // first day of the update window (e.g. today Nov 18 and 3 days -> from Nov 15)
  const recentFrom = UPDATE_RECENT_DAYS > 0
    ? Utilities.formatDate(new Date(Date.now() - UPDATE_RECENT_DAYS * 864e5), destTz, 'yyyy-MM-dd') : '9999-99-99';
  const newRows = [];
  Object.keys(agg).forEach(key => {
    const a = agg[key], row = rowOf[key];
    if (!row) {
      if (SKIP_TODAY && a.dt >= today) { openDay++; return; }
      if (a.dt < cutoff) {
        tooOld++;
        if (tooOld <= 5) log.push([now, s.name, 'SKIP', 'date outside the last ' + LOOKBACK_DAYS + ' days (check day/month order): ' + a.user + ' ' + a.dt + ' ' + a.as + '/' + a.dn]);
        return;
      }
      newRows.push(a);
      return;
    }
    const cur = dv[row - 1];
    const same = (keepAs || toNum_(cur[dc.as]) === a.as) && toNum_(cur[dc.dn]) === a.dn &&
      (!doUp || (toNum_(cur[dc.up]) === a.up && toNum_(cur[dc.nu]) === a.nu));
    if (same) return;
    if (SKIP_TODAY && a.dt >= today) { openDay++; return; }
    const canUpdate = UPDATE_EXISTING || a.dt >= recentFrom;
    if (!canUpdate) {
      kept++;
      if (dry && kept <= 3) log.push([now, s.name, 'KEPT', a.user + ' ' + a.dt + ': tab ' + cur[dc.as] + '/' + cur[dc.dn] + ' vs source ' + a.as + '/' + a.dn + ' (tab kept)']);
      return;
    }
    upd++;
    if (upd <= 10) log.push([now, s.name, dry ? 'DIFF' : 'UPDATED', a.user + ' ' + a.dt + ': ' +
      (keepAs ? '' : 'assigned ' + cur[dc.as] + ' -> ' + a.as + ', ') + 'done ' + cur[dc.dn] + ' -> ' + a.dn +
      (doUp ? ', uploaded ' + cur[dc.up] + ' -> ' + a.up + ', not uploaded ' + cur[dc.nu] + ' -> ' + a.nu : '')]);
    if (dry) return;
    if (!keepAs) ds.getRange(row, dc.as + 1).setValue(a.as);
    ds.getRange(row, dc.dn + 1).setValue(a.dn);
    if (doUp) {
      ds.getRange(row, dc.up + 1).setValue(a.up);
      ds.getRange(row, dc.nu + 1).setValue(a.nu);
    }
  });

  if (!dry && newRows.length) {
    newRows.sort((x, y) => (x.dt < y.dt ? -1 : x.dt > y.dt ? 1 : (x.user < y.user ? -1 : 1)));
    const w = dh.length, start = last + 1;
    const users = newRows.map(a => canon[norm_(a.user)] || a.user);
    const block = newRows.map((a, i) => {
      const r = new Array(w).fill('');
      r[dc.user] = users[i];
      r[dc.date] = Utilities.parseDate(a.dt, destTz, 'yyyy-MM-dd');
      r[dc.as] = a.as; r[dc.dn] = a.dn;
      if (doUp) { r[dc.up] = a.up; r[dc.nu] = a.nu; }
      return r;
    });
    ds.getRange(start, 1, block.length, w).setValues(block);
    ds.getRange(start, dc.date + 1, block.length, 1).setNumberFormat('yyyy-mm-dd');
    // country: copy the rule (formula) from the last row of the tab
    const rule = last > 1 ? ds.getRange(last, dc.country + 1).getFormulaR1C1() : '';
    const target = ds.getRange(start, dc.country + 1, block.length, 1);
    if (rule) target.setFormulaR1C1(rule);
    else {
      target.setValues(users.map(u => [countryOf_(u)]));
      log.push([now, s.name, 'WARN', 'Country rule (formula) not found in the last row; used the BR_AGENTS list']);
    }
    if (dc.pct >= 0) {
      const f = block.map((_, i) => {
        const r = start + i;
        return ['=IFERROR(' + col_(dc.dn + 1) + r + '/' + col_(dc.as + 1) + r + ')'];
      });
      ds.getRange(start, dc.pct + 1, block.length, 1).setFormulas(f).setNumberFormat('0.00%');
    }
  }

  log.push([now, s.name, dry ? 'PREVIEW' : 'OK',
    newRows.length + ' new rows, ' + upd + ' updated (last ' + UPDATE_RECENT_DAYS + ' days), ' + kept +
    ' older rows differ from source (kept), ' + openDay + ' rows of today skipped, ' + tooOld +
    ' rows older than the window skipped' + (dry ? ' (dry run, nothing written)' : '')]);
}

function countryOf_(u) {
  return BR_AGENTS.indexOf(u) >= 0 ? 'Brazil' : (u ? 'China' : '');
}

// accent-insensitive, lowercase: "Cátia" and "Catia" are the same agent
function norm_(u) {
  return String(u).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function numOf_(x, fmt) {
  if (typeof x === 'number') return x;
  if (fmt === 'en') return parseInt(String(x).replace(/,/g, '').trim(), 10) || 0; // "7,797" -> 7797
  return toNum_(x);
}

const MONTHS_ = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 };

/**
 * Returns the date as 'yyyy-MM-dd' text.
 * - A Date coming from Sheets: formatted in the time zone of the spreadsheet it came from (tz).
 * - Text (2026-9-4, 04/09/2026, 28,08, "20th September"): read as is, with no time zone conversion.
 *   When there is no year, CFG.DEFAULT_YEAR is used.
 */
function ymd_(x, tz) {
  let y, m, d, mt;
  if (x instanceof Date) return Utilities.formatDate(x, tz, 'yyyy-MM-dd');
  const s = String(x).trim();
  if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{1,2})[,.\/](\d{1,2})$/))) { d = +mt[1]; m = +mt[2]; y = CFG.DEFAULT_YEAR; }
  else if ((mt = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?$/)) && MONTHS_[mt[2].toLowerCase()]) {
    d = +mt[1]; m = MONTHS_[mt[2].toLowerCase()]; y = mt[3] ? +mt[3] : CFG.DEFAULT_YEAR;
  }
  else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
}

function col_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function appendLog_(rows) {
  if (!rows.length) return;
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(INGEST_LOG) || ss.insertSheet(INGEST_LOG);
  if (sh.getLastRow() === 0) { sh.appendRow(['when', 'source', 'level', 'message']); sh.setFrozenRows(1); }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
}

/**
 * One-off fix: replaces old =IFERROR(E2/D2,0) formulas in items_done_% with =IFERROR(E2/D2),
 * so a missing assigned value shows as blank instead of 0%.
 */
function fixPctFormulas() {
  const ss = SpreadsheetApp.getActive();
  SOURCES.forEach(s => {
    const sh = ss.getSheetByName(s.dest);
    if (!sh || sh.getLastRow() < 2) return;
    const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim().toLowerCase());
    const c = h.indexOf('items_done_%');
    if (c < 0) return;
    const rng = sh.getRange(2, c + 1, sh.getLastRow() - 1, 1);
    const f = rng.getFormulas();
    for (let i = 0; i < f.length; i++) {
      const m = f[i][0].match(/^=IFERROR\(([^,;]+)\/([^,;]+),\s*0\)$/);
      if (m) sh.getRange(i + 2, c + 1).setFormula('=IFERROR(' + m[1] + '/' + m[2] + ')');
    }
  });
}
