/**
 * Serves the Operations Performance Explorer as a Web App that reads the "Main Data" tab when the page
 * opens. Lives in the SAME project as consolidate_main_data.gs and ingest_sources.gs, together with the
 * HTML file "Explorer" (Files > + > HTML, name: Explorer).
 *
 * Deploy: Deploy > New deployment > Type: Web app
 *   - Execute as: Me (viewers do not need access to the master spreadsheet)
 *   - Who has access: anyone in <your company domain>
 * After changing this file or Explorer: Deploy > Manage deployments > Edit > New version
 * (the URL stays the same).
 */
function doGet() {
  const t = HtmlService.createTemplateFromFile('Explorer');
  t.data = safeJson_(mainDataRows_());
  t.meta = safeJson_(refreshMeta_());
  return t.evaluate()
    .setTitle('Operations Performance Explorer')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Main Data rows in the shape the page uses: {country, user, date, task, a, d, u, n}. */
function mainDataRows_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.OUT);
  if (!sh || sh.getLastRow() < 2) return [];
  const tz = ss.getSpreadsheetTimeZone();
  const v = sh.getDataRange().getValues();
  const h = v[0].map(x => String(x).trim().toLowerCase());
  const ix = k => h.indexOf(k);
  const c = ix('country'), u = ix('user'), d = ix('date'), t = ix('task'), a = ix('items_assigned'),
    e = ix('items_done'), up = ix('uploaded'), nu = ix('not_uploaded');
  const rows = [];
  for (let i = 1; i < v.length; i++) {
    const r = v[i], dt = r[d];
    const date = dt instanceof Date ? Utilities.formatDate(dt, tz, 'yyyy-MM-dd') : String(dt).slice(0, 10);
    if (!r[u] || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      country: String(r[c] || ''), user: String(r[u]).trim(), date: date, task: String(r[t] || ''),
      a: toNum_(r[a]), d: toNum_(r[e]), u: up >= 0 ? toNum_(r[up]) : 0, n: nu >= 0 ? toNum_(r[nu]) : 0
    });
  }
  return rows;
}

/** When runDaily last ran and how it ended (stored by ingest_sources.gs). */
function refreshMeta_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return {
    refreshed: p.lastRun ? Utilities.formatDate(new Date(p.lastRun), tz, 'yyyy-MM-dd HH:mm') : '',
    status: p.lastStatus || ''
  };
}

// JSON that is safe inside <script>: a name containing "</script>" cannot break the page.
function safeJson_(x) {
  return JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
