/**
 * Merges every task tab into the "Main Data" tab (the master table).
 * Called by runDaily() in ingest_sources.gs (daily trigger, 6:00-7:00).
 * Set the project time zone in Project Settings > Time zone (e.g. (GMT-03:00) Sao Paulo).
 */
const CFG = {
  TABS: [
    'T1 - Categorization (Front End)', 'T2 - Image Optimisation',
    'T3 - Weight&Volumes', 'T4 - CPG Brand', 'Frontend Category',
    'Backend Category', 'Special Tag', 'Brands New Category Tree', 'Extras'
  ],
  OUT: 'Main Data',
  LOG: 'Consolidation Log',
  DEFAULT_YEAR: 2026 // used when a date has no year (e.g. "28,08")
};
const HEAD = ['country', 'user', 'date', 'task', 'items_assigned', 'items_done',
  'items_done_pct', 'uploaded', 'not_uploaded'];

function consolidate() {
  const ss = SpreadsheetApp.getActive();
  const out = [HEAD], log = [['tab', 'row', 'issue', 'raw value']];
  CFG.TABS.forEach(tab => {
    const sh = ss.getSheetByName(tab);
    if (!sh) { log.push([tab, '', 'Tab not found', '']); return; }
    const v = sh.getDataRange().getValues();
    if (v.length < 2) return;
    const h = v[0].map(x => String(x).trim().toLowerCase());
    const c = h.indexOf('country'), u = h.indexOf('user'), d = h.indexOf('date'),
      a = h.indexOf('items_assigned'), e = h.indexOf('items_done'),
      up = h.indexOf('uploaded'), nu = h.indexOf('not uploaded');
    for (let i = 1; i < v.length; i++) {
      const r = v[i];
      if (!r[u] && !r[d]) continue; // empty row, or only the "to do" column filled
      const dt = toDate_(r[d]);
      if (!r[u] || !dt) { log.push([tab, i + 1, 'Missing user or unreadable date', String(r[d])]); continue; }
      const as = toNum_(r[a]), dn = toNum_(r[e]);
      out.push([r[c] || '', String(r[u]).trim(), dt, tab, as, dn, as ? dn / as : '',
        up >= 0 ? toNum_(r[up]) : '', nu >= 0 ? toNum_(r[nu]) : '']);
    }
  });
  write_(ss, CFG.OUT, out, true);
  write_(ss, CFG.LOG, log, false);
}

function toNum_(x) {
  if (typeof x === 'number') return x;
  const s = String(x).trim();
  if (!s || s === '-') return 0;
  return parseInt(s.replace(/\./g, '').replace(/,.*$/, ''), 10) || 0; // "58.549" -> 58549
}

function toDate_(x) {
  if (x instanceof Date) return x;
  const s = String(x).trim();
  let m;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return mk_(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mk_(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[,.\/](\d{1,2})$/))) return mk_(CFG.DEFAULT_YEAR, +m[2], +m[1]);
  return null;
}

function mk_(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  return dt.getMonth() === mo - 1 ? dt : null;
}

function write_(ss, name, rows, fmt) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  if (fmt && rows.length > 1) {
    sh.getRange(2, 3, rows.length - 1, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, 7, rows.length - 1, 1).setNumberFormat('0.0%');
  }
  sh.setFrozenRows(1);
}
