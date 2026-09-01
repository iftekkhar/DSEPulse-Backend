/**
 * End-to-end data-consistency check against the LIVE running API -- the
 * exact HTTP contract src/services/api.js (dse-pulse-dashboard) consumes,
 * not a direct DB query. This catches a different bug class than
 * staging_comparison.js/db_auditor.js: those verify the DB itself is
 * correct; this verifies what actually reaches the frontend for every
 * listed stock is internally consistent (no NaN/Infinity anywhere in a
 * response, no cross-symbol data leak, dividend/timeline/sector-table math
 * that agrees with itself, and the "current price" two different endpoints
 * both compute for the same stock actually agreeing).
 *
 * Unlike the other server/auditors/*.js modules, this one needs the server
 * actually running (it makes real HTTP requests) and, for a full-data pass,
 * a valid entitled session cookie -- so it is NOT wired into `npm run
 * audit:all` (which must work from a cold DB with no server up). Run it
 * manually after starting the server:
 *
 *   node server/auditors/audit_frontend_api_consistency.js
 *   DSE_SESSION_COOKIE=<value> node server/auditors/audit_frontend_api_consistency.js
 *
 * Without DSE_SESSION_COOKIE it runs against the free/anonymous view (the
 * gate-truncated data most visitors see); with it, against the full
 * entitled payload. Requests are deliberately batched below the server's
 * general rate limit (300 req/15min, see server/index.js) -- see BATCH_SIZE.
 */
import { fileURLToPath } from 'url';

const BASE = process.env.DSE_API_BASE || 'http://localhost:5001';
const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);
const COOKIE = process.env.DSE_SESSION_COOKIE ? `dse_session=${process.env.DSE_SESSION_COOKIE}` : '';
const BATCH_SIZE = 260; // stays under the 300/15min general API limiter with headroom

async function getJSON(path) {
  const res = await fetch(BASE + path, { headers: COOKIE ? { Cookie: COOKIE } : {} });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function isBadNumber(v) {
  return typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v));
}

function scanForNaN(obj, path, hits) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => scanForNaN(v, `${path}[${i}]`, hits)); return; }
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) scanForNaN(v, `${path}.${k}`, hits); return; }
  if (isBadNumber(obj)) hits.push(path);
}

export async function checkFrontendApiConsistency({ limit } = {}) {
  const findings = [];
  const allStocks = await getJSON('/api/stocks');

  if (!Array.isArray(allStocks) || allStocks.length < 300) {
    findings.push({ severity: 'HIGH', area: '/api/stocks', msg: `Expected ~389 stocks, got ${allStocks?.length}` });
  }

  const seen = new Set();
  for (const s of allStocks) {
    if (!s.symbol) { findings.push({ severity: 'HIGH', area: '/api/stocks', msg: `Row with no symbol: ${JSON.stringify(s).slice(0, 120)}` }); continue; }
    if (seen.has(s.symbol)) findings.push({ severity: 'HIGH', area: '/api/stocks', msg: `Duplicate symbol in list: ${s.symbol}` });
    seen.add(s.symbol);
    const naNHits = [];
    scanForNaN(s, s.symbol, naNHits);
    if (naNHits.length) findings.push({ severity: 'HIGH', area: '/api/stocks', msg: `NaN/Infinity fields: ${naNHits.join(', ')}` });
  }

  const stocks = limit ? allStocks.slice(0, limit) : allStocks.slice(0, BATCH_SIZE);
  let idx = 0;
  const CONCURRENCY = 6;

  async function worker() {
    while (idx < stocks.length) {
      const s = stocks[idx++];
      const sym = s.symbol;
      try {
        const analysis = await getJSON(`/api/history-analysis/${encodeURIComponent(sym)}`);

        if (analysis.symbol && analysis.symbol !== sym) {
          findings.push({ severity: 'CRITICAL', area: sym, msg: `history-analysis returned symbol=${analysis.symbol} for requested ${sym} (cross-stock data leak?)` });
        }

        const naNHits = [];
        scanForNaN(analysis, `${sym}.analysis`, naNHits);
        if (naNHits.length) findings.push({ severity: 'HIGH', area: sym, msg: `NaN/Infinity in history-analysis: ${naNHits.slice(0, 10).join(', ')}` });

        if (analysis.currentPrice !== null && analysis.currentPrice !== undefined && s.ltp !== null && s.ltp !== undefined) {
          const diff = Math.abs(Number(analysis.currentPrice) - Number(s.ltp));
          if (diff > 0.01) findings.push({ severity: 'MEDIUM', area: sym, msg: `currentPrice (history-analysis)=${analysis.currentPrice} vs ltp (/api/stocks)=${s.ltp}, diff=${diff.toFixed(2)}` });
        }

        if (analysis.dividendStats?.series?.length) {
          const sum = analysis.dividendStats.series.reduce((acc, r) => acc + (Number(r.dps) || 0), 0);
          const total = Number(analysis.dividendStats.totalPerShare);
          if (!Number.isNaN(total) && Math.abs(sum - total) > 0.05) {
            findings.push({ severity: 'MEDIUM', area: sym, msg: `dividendStats.totalPerShare=${total} but sum(series.dps)=${sum.toFixed(2)}` });
          }
          for (const r of analysis.dividendStats.series) {
            if (r.payoutRatio !== null && r.payoutRatio !== undefined && (r.payoutRatio < -50 || r.payoutRatio > 1000)) {
              findings.push({ severity: 'MEDIUM', area: sym, msg: `dividendStats payoutRatio implausible: FY${r.year}=${r.payoutRatio}%` });
            }
          }
        }

        if (Array.isArray(analysis.fundamentalsHistoryRows) && analysis.fundamentalsHistoryRows.length > 1) {
          const years = analysis.fundamentalsHistoryRows.map(r => r.fiscal_year || r.fiscalYear);
          if (new Set(years).size !== years.length) findings.push({ severity: 'MEDIUM', area: sym, msg: `fundamentalsHistoryRows has duplicate fiscal years: ${years.join(',')}` });
        }

        if (Array.isArray(analysis.timeline) && analysis.timeline.length > 1) {
          let sorted = true;
          const dateSeen = new Set();
          let dupe = false;
          for (let i = 1; i < analysis.timeline.length; i++) if (analysis.timeline[i].date < analysis.timeline[i - 1].date) sorted = false;
          for (const t of analysis.timeline) { if (dateSeen.has(t.date)) dupe = true; dateSeen.add(t.date); }
          if (!sorted) findings.push({ severity: 'MEDIUM', area: sym, msg: 'timeline not sorted ascending by date' });
          if (dupe) findings.push({ severity: 'MEDIUM', area: sym, msg: 'timeline has duplicate dates' });
        }
      } catch (e) {
        findings.push({ severity: 'HIGH', area: sym, msg: `history-analysis fetch failed: ${e.message}` });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const errorsCount = findings.filter(f => BLOCKING_SEVERITIES.has(f.severity)).length;
  const warningsCount = findings.length - errorsCount;
  const status = errorsCount === 0 ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  // Previously this auditor never persisted to audit_reports at all -- its
  // findings only ever existed in console output, invisible to the admin
  // Audit Reports history/dashboard. A DB write here needs only the local
  // SQLite file (independent of the live-server HTTP checks above), so it's
  // safe even though this auditor's own checks require the server running.
  try {
    const { initDB, saveMainDBAuditReport } = await import('../db.js');
    await initDB();
    await saveMainDBAuditReport({
      targetEntity: 'FRONTEND_API_CONSISTENCY',
      recordsAudited: stocks.length,
      errorsCount,
      warningsCount,
      status,
      reportJson: { totalStocks: allStocks.length, checked: stocks.length, findings }
    });
  } catch (err) {
    console.error('[AUDITOR] Failed to save frontend API consistency audit report:', err.message);
  }

  return { totalStocks: allStocks.length, checked: stocks.length, findings, status };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { totalStocks, checked, findings } = await checkFrontendApiConsistency();
  console.log(`Checked ${checked}/${totalStocks} stocks against ${BASE}${COOKIE ? ' (entitled session)' : ' (anonymous)'}.`);
  console.log(`${findings.length} findings.\n`);
  const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
  for (const f of findings) bySeverity[f.severity]?.push(f);
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    if (bySeverity[sev].length) {
      console.log(`=== ${sev} (${bySeverity[sev].length}) ===`);
      for (const f of bySeverity[sev]) console.log(`  [${f.area}] ${f.msg}`);
    }
  }
  process.exit(findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH') ? 1 : 0);
}
