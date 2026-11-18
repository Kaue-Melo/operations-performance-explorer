/**
 * Busca os números das planilhas de origem e alimenta as abas de tarefa da main_control.
 * Usa toNum_ e CFG de consolidate_main_data.gs: os dois arquivos ficam no MESMO projeto.
 *
 * 1) previewIngest(): simula e escreve o resultado em "Ingestion Log" (não grava dados).
 * 2) Se o log estiver certo, rode runDaily() (ingere e depois consolida).
 * 3) installDailyIngestTrigger(): agenda todo dia entre 6:00 e 7:00 (substitui os gatilhos antigos).
 * Se uma execução estourar o tempo (6 min), rode de novo: o script é idempotente.
 */

// Agentes do Brasil; quem não está aqui é tratado como China (mesma regra da planilha).
// Só é usado se a coluna country da aba de destino não tiver a fórmula de regra.
const BR_AGENTS = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Felipe', 'Gabriela', 'Henrique',
  'Isabela', 'João', 'Larissa', 'Marcos'];

// false = linhas que já existem na aba só são atualizadas dentro da janela UPDATE_RECENT_DAYS;
// as mais antigas são preservadas (edições manuais). true = atualiza qualquer linha.
const UPDATE_EXISTING = false;
// Linhas dos últimos N dias (sem contar hoje) são atualizadas pela origem a cada execução,
// para pegar o que foi preenchido depois das 6h. Edições manuais nesses dias são sobrescritas.
// 0 = desliga (comportamento antigo: nunca atualiza linha existente).
const UPDATE_RECENT_DAYS = 3;
// true = não insere nem atualiza o dia de hoje (pode estar incompleto); ele entra na próxima execução.
const SKIP_TODAY = true;
// Só insere dias dos últimos N dias (0 = sem limite). Rede de segurança contra datas digitadas
// ao contrário na origem: elas ficam de fora e aparecem como SKIP no Ingestion Log.
// Para um preenchimento histórico de uma fonte nova, use 0 temporariamente.
const LOOKBACK_DAYS = 45;
// Hora (fuso do projeto, São Paulo) em que o gatilho diário dispara: entre 6:00 e 7:00.
const DAILY_HOUR = 6;

/**
 * cols: nomes dos cabeçalhos da origem, em minúsculas. up/notUp são opcionais.
 * headerRow: linha do cabeçalho na origem (padrão 1).
 * numFmt: 'en' quando a origem usa vírgula como milhar (7,797); padrão é ponto (7.797).
 * dateFromDisplay: true lê a data como aparece na tela (dd/mm/aaaa). Use quando a origem está com
 *   localidade en_US e a equipe digita dd/mm: o Sheets transforma 03/11 em 11 de março.
 * assignedFromSource: false quando a origem NÃO tem itens atribuídos. Nas linhas que já existem,
 *   o atribuído da aba é preservado (só o concluído é atualizado); nas linhas novas,
 *   atribuído = concluído (suposição).
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
    // A origem não tem coluna de itens atribuídos.
    name: 'T3', dest: 'T3 - Weight&Volumes', assignedFromSource: false,
    sourceId: 'YOUR_T3_SOURCE_SHEET_ID', sourceTab: '1. Daily Efficiency',
    cols: { user: 'nick name', date: 'finish', assigned: 'completion', done: 'completion' }
  },
  {
    // Idem T3: a origem não tem coluna de itens atribuídos.
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
 * Execução diária: ingere, consolida e registra quando rodou (lido pelo webapp.gs).
 * Se alguma fonte der erro, as outras seguem e a Main Data é consolidada mesmo assim;
 * o status fica "partial" e o erro é relançado no fim, para o Apps Script mandar o e-mail de falha.
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

// Mantido só por compatibilidade com execuções manuais antigas.
function runWeekly() {
  runDaily();
}

function previewIngest() {
  ingestAll(true);
}

/** Apaga os gatilhos antigos (consolidate, runWeekly, runDaily) e cria um diário entre 6:00 e 7:00. */
function installDailyIngestTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['consolidate', 'runWeekly', 'runDaily'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(DAILY_HOUR).create();
}

/** Devolve a lista de fontes que deram erro (vazia se tudo certo). */
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
  // ---- origem ----
  const srcSS = SpreadsheetApp.openById(s.sourceId);
  const srcTz = srcSS.getSpreadsheetTimeZone();                       // datas da origem: fuso da ORIGEM
  const destTz = SpreadsheetApp.getActive().getSpreadsheetTimeZone(); // datas gravadas: fuso do DESTINO
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

  // soma linhas repetidas do mesmo agente no mesmo dia
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

  // ---- destino ----
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
  const keepAs = s.assignedFromSource === false; // preserva o atribuído já existente na aba

  const rowOf = {}, canon = {};
  let last = 1;
  for (let i = 1; i < dv.length; i++) {
    const r = dv[i];
    const u = String(r[dc.user]).trim();
    if (!u) continue;
    last = i + 1;
    if (!canon[norm_(u)]) canon[norm_(u)] = u; // grafia usada na planilha (ex.: Cátia x Catia)
    const d = ymd_(r[dc.date], destTz);
    if (d) rowOf[norm_(u) + '|' + d] = i + 1;
  }

  let upd = 0, kept = 0, openDay = 0, tooOld = 0;
  const today = Utilities.formatDate(new Date(), destTz, 'yyyy-MM-dd');
  const cutoff = LOOKBACK_DAYS > 0
    ? Utilities.formatDate(new Date(Date.now() - LOOKBACK_DAYS * 864e5), destTz, 'yyyy-MM-dd') : '0000-00-00';
  // primeiro dia da janela de atualização (ex.: hoje 18/11 e 3 dias -> a partir de 15/11)
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
      if (dry && kept <= 3) log.push([now, s.name, 'KEPT', a.user + ' ' + a.dt + ': aba ' + cur[dc.as] + '/' + cur[dc.dn] + ' vs origem ' + a.as + '/' + a.dn + ' (aba preservada)']);
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
    // país: copia a regra (fórmula) da última linha da aba
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
  return BR_AGENTS.indexOf(u) >= 0 ? 'Brasil' : (u ? 'China' : '');
}

// sem acento, minúsculas: "Cátia" e "Catia" são o mesmo agente
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
 * Devolve a data como texto 'yyyy-MM-dd'.
 * - Date vindo do Sheets: formatado no fuso da planilha de onde veio (tz).
 * - Texto (2026-9-4, 04/09/2026, 28,08, "20th September"): lido direto, sem conversão de fuso.
 *   Quando não há ano, usa CFG.DEFAULT_YEAR.
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
 * Rode UMA vez (se ainda houver) para corrigir linhas antigas com =IFERROR(E2/D2,0):
 * troca por =IFERROR(E2/D2) em items_done_%.
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
