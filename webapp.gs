/**
 * Publica o Operations Performance Explorer como Web App, lendo a aba "Main Data" na hora em que
 * a página é aberta. Fica no MESMO projeto de consolidate_main_data.gs e ingest_sources.gs,
 * junto com o arquivo HTML "Explorer" (Arquivos > + > HTML, nome: Explorer).
 *
 * Implantar: Implantar > Nova implantação > Tipo: App da Web
 *   - Executar como: Eu (os leitores não precisam de acesso à main_control)
 *   - Quem pode acessar: qualquer pessoa em <domínio da empresa>
 * Depois de mudar este arquivo ou o Explorer: Implantar > Gerenciar implantações > Editar > Nova versão
 * (o link continua o mesmo).
 */
function doGet() {
  const t = HtmlService.createTemplateFromFile('Explorer');
  t.data = safeJson_(mainDataRows_());
  t.meta = safeJson_(refreshMeta_());
  return t.evaluate()
    .setTitle('Operations Performance Explorer')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Linhas da Main Data no formato que a página usa: {country, user, date, task, a, d, u, n}. */
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

/** Quando o runDaily rodou pela última vez e como terminou (gravado em ingest_sources.gs). */
function refreshMeta_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return {
    refreshed: p.lastRun ? Utilities.formatDate(new Date(p.lastRun), tz, 'yyyy-MM-dd HH:mm') : '',
    status: p.lastStatus || ''
  };
}

// JSON seguro para colar dentro de <script>: um nome com "</script>" não quebra a página.
function safeJson_(x) {
  return JSON.stringify(x).replace(/</g, '\\u003c').replace(/ /g, '\\u2028').replace(/ /g, '\\u2029');
}
