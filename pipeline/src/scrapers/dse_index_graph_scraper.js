/**
 * Real DSEX historical index data from dsebd.org's own chart-data endpoint --
 * a source found 2026-08-23 while investigating why stg_index_history's older
 * DSE_OFFICIAL_ARCHIVE rows couldn't be live-cross-checked (recent_market_
 * information.php only reaches ~30 days back). This endpoint reaches much
 * further: verified live up to duration=200 (~16.7 years), covering
 * 2009-12-24 -> present. Pre-2013 values are literally 0 -- DSEX as an index
 * didn't exist yet (DSE ran a different index before it), so real usable
 * coverage starts 2013, matching the existing data's own start date.
 *
 * URL: https://www.dsebd.org/php_graph/monthly_graph_index.php?type=dseX&duration={months}
 * Format: an HTML page for a JS chart library with the actual data embedded as
 * a `"Date,DSEX Index\n" + "YYYY-MM-DD,value\n"+...` string -- not a clean
 * table or JSON API, so this is regex extraction of that embedded CSV, not a
 * cheerio table parse like the other DSE scrapers use.
 *
 * Value confirmed live 2026-08-23: this endpoint's 2026-08-20 value
 * (5786.08054) matched the already-cross-check-verified recent_market_
 * information.php value for the same date exactly.
 *
 * Scope of what this module does with the data it finds, deliberately narrow:
 *  - Existing Tier 1 rows (DSE_OFFICIAL_ARCHIVE / DSE_OFFICIAL_BENCHMARK) are
 *    only ever COMPARED against this source, never overwritten by it -- both
 *    are already real DSE data, and relabeling them to DSE_OFFICIAL_GRAPH
 *    would lose which specific DSE endpoint each row actually came from for
 *    no benefit. A mismatch here is reported as a real finding, not silently
 *    written over.
 *  - Existing Tier 3 rows (KAGGLE, MCAP_WEIGHTED_ESTIMATE) and any date with
 *    no row at all ARE upgraded to this real Tier 1 source -- this is the
 *    actual value of having found this endpoint: replacing a compiled/
 *    estimated value with a real one where DSE itself has it.
 */
import { initStagingDB, dbAll, dbGet, stageIndexBatch } from '../db/staging_db.js';
import { fetchWithRetry } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';

/**
 * Fetches and parses the full real DSEX series from DSE's chart endpoint.
 * Returns [{ trade_date, index_value }], filtered to real (> 1000) values --
 * the pre-2013 zero placeholders and any zero/garbage points are dropped, not
 * staged as if they were real sessions.
 */
export async function fetchDSEXGraphHistory({ durationMonths = 200 } = {}) {
  const url = `https://www.dsebd.org/php_graph/monthly_graph_index.php?type=dseX&duration=${durationMonths}`;
  const res = await fetchWithRetry(url, { timeout: 30000, attempts: 3, backoffMs: 3000 });
  const pairs = [...res.data.matchAll(/"(\d{4}-\d{2}-\d{2}),([\d.]+)\\n"/g)];
  const out = [];
  for (const [, date, valueStr] of pairs) {
    const value = parseFloat(valueStr);
    if (!isNaN(value) && value > 1000) out.push({ trade_date: date, index_value: value });
  }
  return out;
}

export async function crossCheckAndUpgradeIndexHistory({ durationMonths = 200 } = {}) {
  if (!isScraperEnabled('pipeline.dse_index_graph')) {
    console.log(scraperBlockedMessage('pipeline.dse_index_graph'));
    return { blocked: true };
  }
  await initStagingDB();

  console.log(`\n[DSE Index Graph] Fetching real DSEX history (duration=${durationMonths} months)...`);
  const liveRows = await fetchDSEXGraphHistory({ durationMonths });
  console.log(`[DSE Index Graph] Parsed ${liveRows.length} real DSEX sessions from DSE (${liveRows[0]?.trade_date} -> ${liveRows[liveRows.length - 1]?.trade_date}).`);

  const existingRows = await dbAll('SELECT trade_date, index_value, source FROM stg_index_history');
  const existingMap = new Map(existingRows.map(r => [r.trade_date, r]));

  const tier1Mismatches = [];
  const upgradeCandidates = [];
  let tier1Confirmed = 0;

  for (const live of liveRows) {
    const existing = existingMap.get(live.trade_date);
    if (!existing) {
      upgradeCandidates.push(live);
      continue;
    }
    if (existing.source === 'DSE_OFFICIAL_ARCHIVE' || existing.source === 'DSE_OFFICIAL_BENCHMARK') {
      // Compare only -- never overwrite one real DSE source with another.
      if (Math.abs(existing.index_value - live.index_value) > 0.05) {
        tier1Mismatches.push({ date: live.trade_date, existing_value: existing.index_value, existing_source: existing.source, graph_value: live.index_value });
      } else {
        tier1Confirmed++;
      }
      continue;
    }
    if (existing.source === 'KAGGLE' || existing.source === 'MCAP_WEIGHTED_ESTIMATE') {
      upgradeCandidates.push({ ...live, wasSource: existing.source, wasValue: existing.index_value });
    }
    // Any other existing tier/source (shouldn't happen given the approved list) is left untouched.
  }

  console.log(`\n[DSE Index Graph] Existing Tier 1 rows: ${tier1Confirmed} confirmed matching, ${tier1Mismatches.length} mismatched (reported, not overwritten).`);
  console.log(`[DSE Index Graph] Upgrade candidates (Tier 3 -> Tier 1, or previously missing): ${upgradeCandidates.length}.`);

  if (tier1Mismatches.length > 0) {
    console.log('  Tier 1 mismatches:', JSON.stringify(tier1Mismatches.slice(0, 10), null, 2), tier1Mismatches.length > 10 ? `... and ${tier1Mismatches.length - 10} more` : '');
  }

  let staged = 0;
  if (upgradeCandidates.length > 0) {
    const batch = upgradeCandidates.map(c => ({
      trade_date: c.trade_date,
      index_label: 'DSEX',
      index_value: c.index_value,
      turnover_mn: null,
      total_volume: null,
      source: 'DSE_OFFICIAL_GRAPH',
    }));
    const audit = DataAuditor.auditDSEXHistory(batch);
    if (!audit.passed) {
      console.error('[DSE Index Graph] BLOCKED by audit:', audit.errors);
      return { blocked: true, errors: audit.errors };
    }
    const survivingDates = new Set(audit.cleaned.map(c => c.date));
    const toStage = batch.filter(r => survivingDates.has(r.trade_date));
    staged = await stageIndexBatch(toStage);
    console.log(`[DSE Index Graph] Staged ${staged} rows (Tier 3 -> Tier 1 upgrade / previously-missing dates filled with real data).`);
  }

  return {
    tier1Confirmed,
    tier1Mismatches,
    upgradeCandidatesFound: upgradeCandidates.length,
    staged,
  };
}
