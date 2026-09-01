import { isSqliteAvailable, dbRun, dbAll, dbGet, dbPrepare, withTransaction } from './connection.js';
import { numOrNull } from '../../shared/safe_number.js';
import { tierAllowsOverwrite } from '../../shared/source_tiers.js';

function positiveNumOrNull(val) {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return !isNaN(num) && num > 0 ? num : null;
}

function valueChanged(oldVal, newVal) {
  if (oldVal === null && newVal === null) return false;
  if (oldVal === null || newVal === null) return true;
  return Number(oldVal) !== Number(newVal);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATA QUARANTINE & CONFLICT RESOLUTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function saveConflictToQuarantine({
  targetTable,
  recordIdentifier,
  fieldName,
  existingValue,
  incomingValue,
  liveVerifiedValue = null,
  existingSource = null,
  incomingSource = null,
  notes = null
}) {
  if (!isSqliteAvailable) return null;
  const res = await dbRun(`
    INSERT INTO data_quarantine (
      created_at, target_table, record_identifier, field_name,
      existing_value, incoming_value, live_verified_value,
      existing_source, incoming_source, status, notes
    ) VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_USER_APPROVAL', ?)
  `, [
    targetTable,
    recordIdentifier,
    fieldName,
    existingValue !== null && existingValue !== undefined ? String(existingValue) : null,
    incomingValue !== null && incomingValue !== undefined ? String(incomingValue) : null,
    liveVerifiedValue !== null && liveVerifiedValue !== undefined ? String(liveVerifiedValue) : null,
    existingSource,
    incomingSource,
    notes
  ]);
  console.warn(`⚠️ [QUARANTINE ALERT] Recorded conflicting data for ${targetTable} (${recordIdentifier}, field: ${fieldName}). Existing: ${existingValue} vs Incoming: ${incomingValue}. Locked awaiting user approval.`);
  return res.lastID;
}

export async function getPendingQuarantineConflicts() {
  if (!isSqliteAvailable) return [];
  return dbAll(`SELECT * FROM data_quarantine WHERE status = 'PENDING_USER_APPROVAL' ORDER BY created_at DESC`);
}

export async function resolveQuarantineConflict(id, resolution, userActionNotes = '') {
  if (!isSqliteAvailable) return false;
  const conflict = await dbGet(`SELECT * FROM data_quarantine WHERE id = ?`, [id]);
  if (!conflict) return false;

  const newStatus = resolution === 'ACCEPT_INCOMING' ? 'APPROVED_BY_USER' : 'REJECTED_BY_USER';
  await dbRun(`
    UPDATE data_quarantine
    SET status = ?, notes = COALESCE(notes || '; ', '') || ?
    WHERE id = ?
  `, [newStatus, userActionNotes, id]);

  const ALLOWED_PRICE_FIELDS = new Set([
    'open', 'high', 'low', 'close', 'ycp', 'change', 'change_percent', 'volume', 'value_mn', 'pe', 'trades', 'market_cap_mn', 'source'
  ]);
  const ALLOWED_FUNDAMENTAL_FIELDS = new Set([
    'eps_basic', 'eps_diluted', 'nav_per_share', 'roe', 'dividend_yield', 'paid_up_capital_mn', 'authorized_capital_mn',
    'pe_ratio', 'debt_to_equity', 'current_ratio', 'audit_status', 'eps_quarterly', 'pe_diluted', 'pe_trailing',
    'quarterly_disclosure', 'source', 'dps', 'net_income_mn', 'reserve_surplus_mn', 'oci_mn', 'short_term_loan_mn',
    'long_term_loan_mn', 'bonus_pct', 'revenue_mn', 'gross_profit_mn', 'operating_profit_mn', 'total_assets_mn'
  ]);

  if (resolution === 'ACCEPT_INCOMING') {
    if (conflict.target_table === 'price_history') {
      const parts = conflict.record_identifier.split(':');
      const symbol = parts[0]?.replace('symbol=', '');
      const date = parts[1]?.replace('date=', '');
      if (symbol && date && conflict.field_name && ALLOWED_PRICE_FIELDS.has(conflict.field_name)) {
        await dbRun(`UPDATE price_history SET ${conflict.field_name} = ?, source = ? WHERE symbol = ? AND date = ?`, [
          conflict.incoming_value,
          conflict.incoming_source || 'USER_APPROVED_OVERRIDE',
          symbol,
          date
        ]);
      }
    } else if (conflict.target_table === 'fundamentals_history') {
      const parts = conflict.record_identifier.split(':');
      const symbol = parts[0]?.replace('symbol=', '');
      const year = Number(parts[1]?.replace('fiscal_year=', ''));
      if (symbol && year && conflict.field_name && ALLOWED_FUNDAMENTAL_FIELDS.has(conflict.field_name)) {
        await dbRun(`UPDATE fundamentals_history SET ${conflict.field_name} = ?, source = ? WHERE symbol = ? AND fiscal_year = ?`, [
          conflict.incoming_value,
          conflict.incoming_source || 'USER_APPROVED_OVERRIDE',
          symbol,
          year
        ]);
      }
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PIPELINE-DIRECT WRITE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function savePipelinePriceBatch(symbolOrRecords, maybeRecords = null) {
  let records = [];
  let explicitSymbol = null;
  if (Array.isArray(symbolOrRecords)) {
    records = symbolOrRecords;
  } else {
    explicitSymbol = (symbolOrRecords || '').toUpperCase().trim();
    records = maybeRecords || [];
  }
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  const involvedSymbols = explicitSymbol
    ? [explicitSymbol]
    : [...new Set(records.map(r => (r.symbol || '').toUpperCase().trim()).filter(Boolean))];
  if (involvedSymbols.length === 0) return 0;

  const placeholders = involvedSymbols.map(() => '?').join(',');
  const existingRows = await dbAll(`SELECT symbol, date, source, close FROM price_history WHERE symbol IN (${placeholders})`, involvedSymbols);
  const existingSourceMap = new Map(existingRows.map(r => [`${r.symbol}|${r.date}`, r.source]));
  const existingCloseMap = new Map(existingRows.map(r => [`${r.symbol}|${r.date}`, r.close]));

  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await dbRun('BEGIN TRANSACTION');
    try {
      const stmt = dbPrepare(`
        INSERT INTO price_history
          (symbol, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, trades, market_cap_mn, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, date) DO UPDATE SET
            open=COALESCE(excluded.open, price_history.open),
            high=COALESCE(excluded.high, price_history.high),
            low=COALESCE(excluded.low, price_history.low),
            close=excluded.close,
            ycp=COALESCE(excluded.ycp, price_history.ycp),
            change=COALESCE(excluded.change, price_history.change),
            change_percent=COALESCE(excluded.change_percent, price_history.change_percent),
            volume=COALESCE(excluded.volume, price_history.volume),
            value_mn=COALESCE(excluded.value_mn, price_history.value_mn),
            trades=COALESCE(excluded.trades, price_history.trades),
            market_cap_mn=COALESCE(excluded.market_cap_mn, price_history.market_cap_mn),
            source=excluded.source
      `);
      for (const r of batch) {
        const sym = (r.symbol || explicitSymbol || '').toUpperCase().trim();
        if (!sym || !r.trade_date || r.close == null || Number(r.close) <= 0) continue;
        const src = r.source || 'DSE_SCRAPE';
        const key = `${sym}|${r.trade_date}`;
        if (!tierAllowsOverwrite(existingSourceMap.get(key), src)) {
          blockedByTier++;
          if (valueChanged(existingCloseMap.get(key), r.close)) {
            quarantined++;
            await saveConflictToQuarantine({
              targetTable: 'price_history',
              recordIdentifier: key,
              fieldName: 'close',
              existingValue: existingCloseMap.get(key),
              incomingValue: r.close,
              existingSource: existingSourceMap.get(key),
              incomingSource: src,
              notes: 'savePipelinePriceBatch: lower/equal-tier source reported a different close price than the stored value.'
            });
          }
          continue;
        }
        stmt.run([
          sym,
          r.trade_date,
          r.open != null ? Number(r.open) : null,
          r.high != null ? Number(r.high) : null,
          r.low  != null ? Number(r.low)  : null,
          Number(r.close),
          r.ycp  != null ? Number(r.ycp)  : null,
          r.change_amt != null ? Number(r.change_amt) : null,
          r.change_pct != null ? Number(r.change_pct) : null,
          r.volume != null ? parseInt(r.volume) : null,
          r.value_mn != null ? Number(r.value_mn) : null,
          r.trades != null ? parseInt(r.trades) : null,
          r.market_cap_mn != null ? Number(r.market_cap_mn) : null,
          src,
        ]);
        count++;
      }
      await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK');
      throw err;
    }
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] savePipelinePriceBatch: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function savePipelineFundamentals(symbol, records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;
  const cleanSym = (symbol || '').toUpperCase().trim();
  if (!cleanSym) return 0;

  return withTransaction(async () => {
    let count = 0;
    // source is bound from each record (r.source, defaulting to
    // 'DSE_OFFICIAL' when a caller doesn't set it -- every current caller
    // scrapes from dsebd.org, so this default preserves existing behavior
    // exactly) rather than hardcoded in the SQL text. Previously this
    // function force-wrote 'DSE_OFFICIAL' onto every row regardless of what
    // the record's own source field said -- harmless while every caller
    // happens to pass a matching source, but a landmine the day one doesn't
    // (a mistagged record would be silently relabeled with the highest-trust
    // Tier 1 source instead of failing loudly or recording what it actually
    // was).
    const stmt = dbPrepare(`
      INSERT INTO fundamentals_history (
        symbol, fiscal_year, period, eps_basic, eps_diluted, nav_per_share, roe,
        dividend_yield, dps, pe_ratio, debt_to_equity, current_ratio,
        paid_up_capital_mn, authorized_capital_mn, net_income_mn, reserve_surplus_mn, oci_mn,
        short_term_loan_mn, long_term_loan_mn, bonus_pct,
        audit_status, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Audited', ?)
      ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
        period = excluded.period,
        eps_basic = excluded.eps_basic,
        eps_diluted = COALESCE(excluded.eps_diluted, fundamentals_history.eps_diluted),
        nav_per_share = excluded.nav_per_share,
        roe = excluded.roe,
        dividend_yield = excluded.dividend_yield,
        dps = excluded.dps,
        pe_ratio = excluded.pe_ratio,
        debt_to_equity = excluded.debt_to_equity,
        current_ratio = excluded.current_ratio,
        paid_up_capital_mn = excluded.paid_up_capital_mn,
        authorized_capital_mn = COALESCE(excluded.authorized_capital_mn, fundamentals_history.authorized_capital_mn),
        net_income_mn = COALESCE(excluded.net_income_mn, fundamentals_history.net_income_mn),
        reserve_surplus_mn = COALESCE(excluded.reserve_surplus_mn, fundamentals_history.reserve_surplus_mn),
        oci_mn = COALESCE(excluded.oci_mn, fundamentals_history.oci_mn),
        short_term_loan_mn = COALESCE(excluded.short_term_loan_mn, fundamentals_history.short_term_loan_mn),
        long_term_loan_mn = COALESCE(excluded.long_term_loan_mn, fundamentals_history.long_term_loan_mn),
        bonus_pct = COALESCE(excluded.bonus_pct, fundamentals_history.bonus_pct),
        audit_status = 'Audited',
        source = excluded.source
      WHERE fundamentals_history.audit_status IS NOT 'Audited'
         OR fundamentals_history.source = 'STAGING_DB'
         OR fundamentals_history.net_income_mn IS NULL
         OR fundamentals_history.reserve_surplus_mn IS NULL
         OR fundamentals_history.short_term_loan_mn IS NULL
         OR fundamentals_history.long_term_loan_mn IS NULL
    `);
    let latestReserve = null;
    let latestOci = null;
    let latestShortLoan = null;
    let latestLongLoan = null;

    for (const r of records) {
      if (!r.fiscal_year) continue;
      stmt.run([
        cleanSym,
        Number(r.fiscal_year),
        r.period || 'Annual',
        r.eps ?? null,
        r.eps_diluted ?? null,
        r.navps ?? null,
        r.roe ?? null,
        r.dividend_yield ?? null,
        r.dps ?? null,
        r.pe_ratio ?? null,
        r.debt_to_equity ?? null,
        r.current_ratio ?? null,
        r.paid_up_capital_mn ?? null,
        r.authorized_capital_mn ?? null,
        r.net_income_mn ?? null,
        r.reserve_surplus_mn ?? null,
        r.oci_mn ?? null,
        r.short_term_loan_mn ?? null,
        r.long_term_loan_mn ?? null,
        r.bonus_pct ?? null,
        r.source || 'DSE_OFFICIAL',
      ]);
      if (r.reserve_surplus_mn !== null && r.reserve_surplus_mn !== undefined) latestReserve = r.reserve_surplus_mn;
      if (r.oci_mn !== null && r.oci_mn !== undefined) latestOci = r.oci_mn;
      if (r.short_term_loan_mn !== null && r.short_term_loan_mn !== undefined) latestShortLoan = r.short_term_loan_mn;
      if (r.long_term_loan_mn !== null && r.long_term_loan_mn !== undefined) latestLongLoan = r.long_term_loan_mn;
      count++;
    }
    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));

    if (latestReserve !== null || latestOci !== null || latestShortLoan !== null || latestLongLoan !== null) {
      await dbRun(
        `UPDATE company_list
         SET reserve_surplus_mn = COALESCE(?, reserve_surplus_mn),
             oci_mn = COALESCE(?, oci_mn),
             short_term_loan_mn = COALESCE(?, short_term_loan_mn),
             long_term_loan_mn = COALESCE(?, long_term_loan_mn)
         WHERE symbol = ?`,
        [latestReserve, latestOci, latestShortLoan, latestLongLoan, cleanSym]
      );
    }
    return count;
  });
}

export async function savePipelineIndexBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  const existingRows = await dbAll('SELECT date, source, dsex_index FROM dsex_market_history');
  const existingSourceMap = new Map(existingRows.map(r => [r.date, r.source]));
  const existingIndexMap = new Map(existingRows.map(r => [r.date, r.dsex_index]));

  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await dbRun('BEGIN TRANSACTION');
    try {
      const stmt = dbPrepare(`
        INSERT INTO dsex_market_history
          (date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(date) DO UPDATE SET
            dsex_index=excluded.dsex_index,
            advancing=COALESCE(excluded.advancing, dsex_market_history.advancing),
            declining=COALESCE(excluded.declining, dsex_market_history.declining),
            unchanged=COALESCE(excluded.unchanged, dsex_market_history.unchanged),
            total_volume=COALESCE(excluded.total_volume, dsex_market_history.total_volume),
            total_value_mn=COALESCE(excluded.total_value_mn, dsex_market_history.total_value_mn),
            source=excluded.source
      `);
      for (const r of batch) {
        if (!r.trade_date || !r.index_value || Number(r.index_value) <= 0) continue;
        const src = r.source || 'DSE_OFFICIAL_GRAPH';
        if (!tierAllowsOverwrite(existingSourceMap.get(r.trade_date), src)) {
          blockedByTier++;
          if (valueChanged(existingIndexMap.get(r.trade_date), r.index_value)) {
            quarantined++;
            await saveConflictToQuarantine({
              targetTable: 'dsex_market_history',
              recordIdentifier: r.trade_date,
              fieldName: 'dsex_index',
              existingValue: existingIndexMap.get(r.trade_date),
              incomingValue: r.index_value,
              existingSource: existingSourceMap.get(r.trade_date),
              incomingSource: src,
              notes: 'savePipelineIndexBatch: lower/equal-tier source reported a different DSEX index value than the stored value.'
            });
          }
          continue;
        }
        stmt.run([
          r.trade_date,
          Number(r.index_value),
          r.advancing ?? null,
          r.declining ?? null,
          r.unchanged ?? null,
          r.total_trades ?? null,
          r.total_volume ?? null,
          r.turnover_mn ?? r.total_value_mn ?? null,
          src,
        ]);
        count++;
      }
      await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK');
      throw err;
    }
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] savePipelineIndexBatch: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function savePipelineDS30IndexBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  // Tier-priority guard, added to match savePipelineIndexBatch's (DSEX) same
  // protection -- previously this write path had none at all, unlike its
  // DSEX sibling, so a lower-tier DS30 source could have silently overwritten
  // a higher-tier one with no warning and nothing quarantined.
  const existingRows = await dbAll('SELECT date, source, ds30_index FROM ds30_index_history');
  const existingSourceMap = new Map(existingRows.map(r => [r.date, r.source]));
  const existingIndexMap = new Map(existingRows.map(r => [r.date, r.ds30_index]));

  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await dbRun('BEGIN TRANSACTION');
    try {
      const stmt = dbPrepare(`
        INSERT INTO ds30_index_history
          (date, ds30_index, prev_close, change_percent, source, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(date) DO UPDATE SET
            ds30_index = excluded.ds30_index,
            prev_close = COALESCE(excluded.prev_close, ds30_index_history.prev_close),
            change_percent = COALESCE(excluded.change_percent, ds30_index_history.change_percent),
            source = COALESCE(excluded.source, ds30_index_history.source)
      `);
      for (const r of batch) {
        if (!r.date || !r.ds30_index || Number(r.ds30_index) <= 0) continue;
        const src = r.source || 'DSE_OFFICIAL_GRAPH';
        if (!tierAllowsOverwrite(existingSourceMap.get(r.date), src)) {
          blockedByTier++;
          if (valueChanged(existingIndexMap.get(r.date), r.ds30_index)) {
            quarantined++;
            await saveConflictToQuarantine({
              targetTable: 'ds30_index_history',
              recordIdentifier: r.date,
              fieldName: 'ds30_index',
              existingValue: existingIndexMap.get(r.date),
              incomingValue: r.ds30_index,
              existingSource: existingSourceMap.get(r.date),
              incomingSource: src,
              notes: 'savePipelineDS30IndexBatch: lower/equal-tier source reported a different DS30 index value than the stored value.'
            });
          }
          continue;
        }
        stmt.run([
          r.date,
          Number(r.ds30_index),
          r.prev_close ?? null,
          r.change_percent ?? null,
          src,
        ]);
        count++;
      }
      await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK');
      throw err;
    }
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] savePipelineDS30IndexBatch: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function saveBlockMarketBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  // Tier-priority guard, added 2026-09-01 -- previously this write path had
  // none at all, unlike price_history/dsex_market_history's equivalents.
  // Single-sourced (LANKABD only) today, so no active conflict exists yet,
  // but a second source arriving later would otherwise silently overwrite
  // with no warning and nothing quarantined.
  const involvedSymbols = [...new Set(records.map(r => (r.symbol || '').toUpperCase().trim()).filter(Boolean))];
  const existingRows = involvedSymbols.length > 0
    ? await dbAll(`SELECT symbol, date, source, quantity FROM block_market_history WHERE symbol IN (${involvedSymbols.map(() => '?').join(',')})`, involvedSymbols)
    : [];
  const existingSourceMap = new Map(existingRows.map(r => [`${r.symbol}|${r.date}`, r.source]));
  const existingQuantityMap = new Map(existingRows.map(r => [`${r.symbol}|${r.date}`, r.quantity]));

  const BATCH_SIZE = 500;
  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await dbRun('BEGIN TRANSACTION');
    try {
      const stmt = dbPrepare(`
        INSERT INTO block_market_history
          (symbol, date, trades, quantity, value_mn, min_price, max_price, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, date) DO UPDATE SET
            trades=COALESCE(excluded.trades, block_market_history.trades),
            quantity=COALESCE(excluded.quantity, block_market_history.quantity),
            value_mn=COALESCE(excluded.value_mn, block_market_history.value_mn),
            min_price=COALESCE(excluded.min_price, block_market_history.min_price),
            max_price=COALESCE(excluded.max_price, block_market_history.max_price),
            source=excluded.source
      `);
      for (const r of batch) {
        const sym = (r.symbol || '').toUpperCase().trim();
        if (!sym || !r.date) continue;
        const src = r.source || 'LANKABD';
        const key = `${sym}|${r.date}`;
        if (!tierAllowsOverwrite(existingSourceMap.get(key), src)) {
          blockedByTier++;
          if (valueChanged(existingQuantityMap.get(key), r.quantity)) {
            quarantined++;
            await saveConflictToQuarantine({
              targetTable: 'block_market_history',
              recordIdentifier: key,
              fieldName: 'quantity',
              existingValue: existingQuantityMap.get(key),
              incomingValue: r.quantity,
              existingSource: existingSourceMap.get(key),
              incomingSource: src,
              notes: 'saveBlockMarketBatch: lower/equal-tier source reported a different quantity than the stored value.'
            });
          }
          continue;
        }
        stmt.run([
          sym,
          r.date,
          r.trades != null ? parseInt(r.trades) : null,
          r.quantity != null ? parseInt(r.quantity) : null,
          r.value_mn != null ? Number(r.value_mn) : null,
          r.min_price != null ? Number(r.min_price) : null,
          r.max_price != null ? Number(r.max_price) : null,
          src
        ]);
        count++;
      }
      await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK');
      throw err;
    }
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] saveBlockMarketBatch: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function saveCreditRatingBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  const stmt = dbPrepare(`
    INSERT INTO credit_ratings
      (symbol, rating_agency, long_term_rating, short_term_rating, outlook, rating_date, valid_until, rating_action, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, rating_date, rating_agency) DO UPDATE SET
        long_term_rating = excluded.long_term_rating,
        short_term_rating = excluded.short_term_rating,
        outlook = excluded.outlook,
        valid_until = excluded.valid_until,
        rating_action = excluded.rating_action,
        source = excluded.source
  `);

  let count = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    for (const r of records) {
      const sym = (r.symbol || '').toUpperCase().trim();
      if (!sym || !r.rating_date) continue;
      stmt.run([
        sym,
        r.rating_agency || 'CRISL',
        r.long_term_rating || null,
        r.short_term_rating || null,
        r.outlook || 'Stable',
        r.rating_date,
        r.valid_until || null,
        r.rating_action || 'Surveillance',
        r.source || 'DSE_OFFICIAL'
      ]);
      count++;
    }
    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  return count;
}

export async function saveShareLockinsBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  const stmt = dbPrepare(`
    INSERT INTO share_lockins
      (symbol, lockin_category, quantity, release_date, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol, lockin_category, release_date) DO UPDATE SET
        quantity = excluded.quantity,
        source = excluded.source
  `);

  let count = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    for (const r of records) {
      const sym = (r.symbol || '').toUpperCase().trim();
      if (!sym || !r.release_date) continue;
      stmt.run([
        sym,
        r.lockin_category || 'Sponsor/Director',
        r.quantity != null ? parseInt(r.quantity, 10) : null,
        r.release_date,
        r.source || 'DSE_OFFICIAL'
      ]);
      count++;
    }
    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  return count;
}

export async function savePdfFinancialStatementsBatch(records = []) {
  if (!records || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;

  // source is bound per-record (r.source, defaulting to
  // 'PDF_AUDITED_ANNUAL_REPORT' when a caller doesn't set it -- the only
  // current caller, scrapePdfFinancialStatements(), never sets r.source, so
  // this default preserves existing behavior exactly) rather than hardcoded
  // in the SQL text.
  const stmt = dbPrepare(`
    INSERT INTO fundamentals_history (
      symbol, fiscal_year, period, eps_basic, eps_diluted, nav_per_share, roe,
      paid_up_capital_mn, net_income_mn, reserve_surplus_mn, oci_mn,
      short_term_loan_mn, long_term_loan_mn,
      revenue_mn, gross_profit_mn, operating_profit_mn,
      total_assets_mn, total_liabilities_mn, current_assets_mn, current_liabilities_mn,
      capex_mn, operating_cash_flow_mn, free_cash_flow_mn,
      audit_status, source, recorded_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      'Audited', ?, datetime('now')
    )
    ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
      period = COALESCE(excluded.period, fundamentals_history.period),
      eps_basic = COALESCE(excluded.eps_basic, fundamentals_history.eps_basic),
      eps_diluted = COALESCE(excluded.eps_diluted, fundamentals_history.eps_diluted),
      nav_per_share = COALESCE(excluded.nav_per_share, fundamentals_history.nav_per_share),
      roe = COALESCE(excluded.roe, fundamentals_history.roe),
      paid_up_capital_mn = COALESCE(excluded.paid_up_capital_mn, fundamentals_history.paid_up_capital_mn),
      net_income_mn = COALESCE(excluded.net_income_mn, fundamentals_history.net_income_mn),
      reserve_surplus_mn = COALESCE(excluded.reserve_surplus_mn, fundamentals_history.reserve_surplus_mn),
      oci_mn = COALESCE(excluded.oci_mn, fundamentals_history.oci_mn),
      short_term_loan_mn = COALESCE(excluded.short_term_loan_mn, fundamentals_history.short_term_loan_mn),
      long_term_loan_mn = COALESCE(excluded.long_term_loan_mn, fundamentals_history.long_term_loan_mn),
      revenue_mn = COALESCE(excluded.revenue_mn, fundamentals_history.revenue_mn),
      gross_profit_mn = COALESCE(excluded.gross_profit_mn, fundamentals_history.gross_profit_mn),
      operating_profit_mn = COALESCE(excluded.operating_profit_mn, fundamentals_history.operating_profit_mn),
      total_assets_mn = COALESCE(excluded.total_assets_mn, fundamentals_history.total_assets_mn),
      total_liabilities_mn = COALESCE(excluded.total_liabilities_mn, fundamentals_history.total_liabilities_mn),
      current_assets_mn = COALESCE(excluded.current_assets_mn, fundamentals_history.current_assets_mn),
      current_liabilities_mn = COALESCE(excluded.current_liabilities_mn, fundamentals_history.current_liabilities_mn),
      capex_mn = COALESCE(excluded.capex_mn, fundamentals_history.capex_mn),
      operating_cash_flow_mn = COALESCE(excluded.operating_cash_flow_mn, fundamentals_history.operating_cash_flow_mn),
      free_cash_flow_mn = COALESCE(excluded.free_cash_flow_mn, fundamentals_history.free_cash_flow_mn),
      audit_status = 'Audited',
      source = excluded.source,
      recorded_at = datetime('now')
    WHERE fundamentals_history.audit_status IS NOT 'Audited'
       OR fundamentals_history.source = 'STAGING_DB'
       OR fundamentals_history.revenue_mn IS NULL
       OR fundamentals_history.total_assets_mn IS NULL
       OR fundamentals_history.total_liabilities_mn IS NULL
  `);

  let count = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    for (const r of records) {
      const sym = (r.symbol || '').toUpperCase().trim();
      if (!sym || !r.fiscal_year) continue;
      stmt.run([
        sym,
        parseInt(r.fiscal_year, 10),
        r.period || 'Annual',
        r.eps_basic ?? null,
        r.eps_diluted ?? null,
        r.nav_per_share ?? null,
        r.roe ?? null,
        r.paid_up_capital_mn ?? null,
        r.net_income_mn ?? null,
        r.reserve_surplus_mn ?? null,
        r.oci_mn ?? null,
        r.short_term_loan_mn ?? null,
        r.long_term_loan_mn ?? null,
        r.revenue_mn ?? null,
        r.gross_profit_mn ?? null,
        r.operating_profit_mn ?? null,
        r.total_assets_mn ?? null,
        r.total_liabilities_mn ?? null,
        r.current_assets_mn ?? null,
        r.current_liabilities_mn ?? null,
        r.capex_mn ?? null,
        r.operating_cash_flow_mn ?? null,
        r.free_cash_flow_mn ?? null,
        r.source || 'PDF_AUDITED_ANNUAL_REPORT'
      ]);
      count++;
    }
    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  return count;
}

export async function saveDailyClosingToDB(records, dateStr) {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  const existingRows = await dbAll(`SELECT symbol, source, close FROM price_history WHERE date = ?`, [targetDate]);
  const existingSourceMap = new Map(existingRows.map(r => [r.symbol, r.source]));
  const existingCloseMap = new Map(existingRows.map(r => [r.symbol, r.close]));

  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, close, ycp, change, change_percent, volume, high, low, value_mn, pe, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        high = COALESCE(excluded.high, price_history.high),
        low = COALESCE(excluded.low, price_history.low),
        value_mn = COALESCE(excluded.value_mn, price_history.value_mn),
        pe = excluded.pe,
        source = COALESCE(excluded.source, price_history.source)
    `);

    for (const r of records) {
      const symbol = (r.symbol || '').toUpperCase().trim();
      const closeRaw = r.ltp ?? r.close ?? r.closePrice ?? null;
      const close = closeRaw !== null ? Number(closeRaw) : null;
      if (!symbol || close === null || close <= 0) continue;

      const ycp = numOrNull(r.ycp);
      const change = numOrNull(r.change)
        ?? (ycp !== null && ycp > 0 ? Number((close - ycp).toFixed(2)) : null);
      const change_percent = numOrNull(r.changePercent)
        ?? (ycp !== null && ycp > 0 ? Number((((close - ycp) / ycp) * 100).toFixed(2)) : null);
      const volume = numOrNull(r.volume);
      const high = numOrNull(r.high);
      const low = numOrNull(r.low);
      const value_mn = numOrNull(r.value ?? r.value_mn);
      const pe = numOrNull(r.pe);
      const source = r.source || null;

      if (!tierAllowsOverwrite(existingSourceMap.get(symbol), source)) {
        blockedByTier++;
        if (valueChanged(existingCloseMap.get(symbol), close)) {
          quarantined++;
          await saveConflictToQuarantine({
            targetTable: 'price_history',
            recordIdentifier: `${symbol}|${targetDate}`,
            fieldName: 'close',
            existingValue: existingCloseMap.get(symbol),
            incomingValue: close,
            existingSource: existingSourceMap.get(symbol),
            incomingSource: source,
            notes: 'saveDailyClosingToDB: lower/equal-tier source reported a different close price than the stored value.'
          });
        }
        continue;
      }

      stmt.run([symbol, targetDate, close, ycp, change, change_percent, volume, high, low, value_mn, pe, source]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] saveDailyClosingToDB: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function saveSymbolHistoryBulk(symbol, records) {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  if (!isSqliteAvailable) return 0;
  const cleanSym = (symbol || '').toUpperCase().trim();
  if (!cleanSym) return 0;

  const existingRows = await dbAll(`SELECT date, source, close FROM price_history WHERE symbol = ?`, [cleanSym]);
  const existingSourceMap = new Map(existingRows.map(r => [r.date, r.source]));
  const existingCloseMap = new Map(existingRows.map(r => [r.date, r.close]));

  let count = 0;
  let blockedByTier = 0;
  let quarantined = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, pe, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        value_mn = excluded.value_mn,
        pe = excluded.pe,
        source = COALESCE(excluded.source, price_history.source)
    `);

    for (const r of records) {
      const date = r.date;
      const closeRaw = r.close ?? r.ltp ?? null;
      const close = closeRaw !== null ? Number(closeRaw) : null;
      if (!date || close === null || close <= 0) continue;

      const open = numOrNull(r.open);
      const high = numOrNull(r.high);
      const low = numOrNull(r.low);
      const ycp = numOrNull(r.ycp);
      const change = numOrNull(r.change);
      const change_percent = numOrNull(r.changePercent);
      const volume = numOrNull(r.volume);
      const value_mn = numOrNull(r.valueMn);
      const pe = numOrNull(r.pe);
      const source = r.source || null;

      if (!tierAllowsOverwrite(existingSourceMap.get(date), source)) {
        blockedByTier++;
        if (valueChanged(existingCloseMap.get(date), close)) {
          quarantined++;
          await saveConflictToQuarantine({
            targetTable: 'price_history',
            recordIdentifier: `${cleanSym}|${date}`,
            fieldName: 'close',
            existingValue: existingCloseMap.get(date),
            incomingValue: close,
            existingSource: existingSourceMap.get(date),
            incomingSource: source,
            notes: 'saveSymbolHistoryBulk: lower/equal-tier source reported a different close price than the stored value.'
          });
        }
        continue;
      }

      stmt.run([cleanSym, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, pe, source]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] saveSymbolHistoryBulk(${cleanSym}): ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (${quarantined} genuinely conflicting, quarantined for review).`);
  }
  return count;
}

export async function saveCompanyList(records = []) {
  if (!records.length) return { upserted: 0, delisted: 0 };
  const todayDhaka = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  const existingRows = await dbAll('SELECT symbol, category, is_new_listing, first_scraped_at, trading_status FROM company_list');
  const existingMap = new Map(existingRows.map(r => [r.symbol, r]));

  return withTransaction(async () => {
    let upserted = 0;
    const stmt = dbPrepare(`
      INSERT INTO company_list (
        symbol, name, sector, category, listing_date, face_value, total_shares, market_cap_mn,
        is_active, fetched_at, source, is_new_listing, first_scraped_at, trading_status,
        prev_category, category_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        name = COALESCE(excluded.name, company_list.name),
        sector = COALESCE(excluded.sector, company_list.sector),
        prev_category = CASE
          WHEN excluded.category IS NOT NULL AND excluded.category != company_list.category
          THEN company_list.category
          ELSE company_list.prev_category
        END,
        category_changed_at = CASE
          WHEN excluded.category IS NOT NULL AND excluded.category != company_list.category
          THEN excluded.category_changed_at
          ELSE company_list.category_changed_at
        END,
        category = COALESCE(excluded.category, company_list.category),
        listing_date = COALESCE(excluded.listing_date, company_list.listing_date),
        face_value = COALESCE(excluded.face_value, company_list.face_value),
        total_shares = COALESCE(excluded.total_shares, company_list.total_shares),
        market_cap_mn = COALESCE(excluded.market_cap_mn, company_list.market_cap_mn),
        is_active = 1,
        trading_status = 'Active',
        fetched_at = excluded.fetched_at,
        source = excluded.source
    `);

    for (const r of records) {
      const symbol = (r.symbol || '').toUpperCase().trim();
      if (!symbol) continue;
      const existing = existingMap.get(symbol);
      const isBrandNew = !existing;
      const categoryChanged = existing && r.category && existing.category && existing.category !== r.category;

      const prevCategory = categoryChanged ? existing.category : null;
      const categoryChangedAt = categoryChanged ? todayDhaka : null;
      const isNewListing = isBrandNew ? 1 : (existing?.is_new_listing ? 1 : 0);
      const firstScrapedAt = isBrandNew ? todayDhaka : (existing?.first_scraped_at ?? todayDhaka);

      stmt.run([
        symbol,
        r.name ?? null,
        r.sector ?? null,
        r.category ?? null,
        r.listing_date ?? null,
        r.face_value ?? null,
        r.total_shares ?? null,
        r.market_cap_mn ?? null,
        1,
        r.fetched_at || new Date().toISOString(),
        r.source || 'DSE_SCRAPE',
        isNewListing,
        firstScrapedAt,
        'Active',
        prevCategory,
        categoryChangedAt
      ]);
      upserted++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));

    const validSymbols = new Set(records.map(r => (r.symbol || '').toUpperCase().trim()).filter(Boolean));
    const toDelist = existingRows.filter(r => !validSymbols.has(r.symbol) && r.trading_status === 'Active');
    let delistedCount = 0;

    if (toDelist.length > 0) {
      const delistStmt = dbPrepare(`
        UPDATE company_list
        SET trading_status = 'Delisted',
            delisted_date = ?,
            is_active = 0
        WHERE symbol = ?
      `);
      for (const d of toDelist) {
        delistStmt.run([todayDhaka, d.symbol]);
        delistedCount++;
      }
      await new Promise((res, rej) => delistStmt.finalize(err => err ? rej(err) : res()));
      console.log(`[SQLITE] Non-Destructive Update: Marked ${delistedCount} removed symbols as 'Delisted' (0 data deleted).`);
    }

    return { upserted, delisted: delistedCount };
  });
}

export async function saveMainDBAuditReport({ targetEntity, recordsAudited, errorsCount, warningsCount, status, reportJson }) {
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [new Date().toISOString(), targetEntity, recordsAudited, errorsCount, warningsCount, status, reportJson ? JSON.stringify(reportJson) : null]);
}

export async function saveFundamentalsBulkDelta(records) {
  if (!records || !Array.isArray(records) || records.length === 0) {
    return { total: 0, changedCount: 0, unchangedCount: 0, changedSymbols: [] };
  }
  if (!isSqliteAvailable) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  const withYear = records.filter(r => r && r.symbol && (r.fiscalYear || r.fiscal_year));
  if (withYear.length === 0) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  const keys = withYear.map(r => [String(r.symbol).toUpperCase().trim(), Number(r.fiscalYear ?? r.fiscal_year)]);
  const involvedSymbols = [...new Set(keys.map(([sym]) => sym))];
  const symPlaceholders = involvedSymbols.map(() => '?').join(',');
  const existingRows = involvedSymbols.length > 0
    ? await dbAll(`SELECT * FROM fundamentals_history WHERE symbol IN (${symPlaceholders})`, involvedSymbols)
    : [];
  const existingMap = new Map();
  for (const row of existingRows) {
    existingMap.set(`${row.symbol}|${row.fiscal_year}`, row);
  }

  const toUpdate = [];
  const changedSymbols = [];

  for (const r of withYear) {
    const sym = String(r.symbol).toUpperCase().trim();
    const yr = Number(r.fiscalYear ?? r.fiscal_year);
    const existing = existingMap.get(`${sym}|${yr}`);

    if (existing && existing.audit_status === 'Audited') continue;

    if (!existing) {
      toUpdate.push({ ...r, symbol: sym, fiscalYear: yr });
      changedSymbols.push(sym);
      continue;
    }

    const epsNew = numOrNull(r.epsBasic) ?? numOrNull(r.eps);
    const navNew = numOrNull(r.navPerShare);
    const paidUpNew = numOrNull(r.paidUpCapitalMn) ?? numOrNull(r.paidUpCapital);
    const periodNew = r.auditedPeriod || null;
    const debtNew = numOrNull(r.debtToEquity);
    const crNew = numOrNull(r.currentRatio);

    const epsChanged = valueChanged(existing.eps_basic, epsNew);
    const navChanged = valueChanged(existing.nav_per_share, navNew);
    const paidUpChanged = valueChanged(existing.paid_up_capital_mn, paidUpNew);
    const periodChanged = existing.period !== periodNew;
    const debtChanged = valueChanged(existing.debt_to_equity, debtNew);
    const crChanged = valueChanged(existing.current_ratio, crNew);
    const netIncomeChanged = valueChanged(existing.net_income_mn, numOrNull(r.netIncomeMn ?? r.net_income_mn));
    const reserveChanged = valueChanged(existing.reserve_surplus_mn, numOrNull(r.reserveSurplusMn ?? r.reserve_surplus_mn));
    const ociChanged = valueChanged(existing.oci_mn, numOrNull(r.ociMn ?? r.oci_mn));
    const shortLoanChanged = valueChanged(existing.short_term_loan_mn, numOrNull(r.shortTermLoanMn ?? r.short_term_loan_mn));
    const longLoanChanged = valueChanged(existing.long_term_loan_mn, numOrNull(r.longTermLoanMn ?? r.long_term_loan_mn));

    if (epsChanged || navChanged || paidUpChanged || periodChanged || debtChanged || crChanged || netIncomeChanged || reserveChanged || ociChanged || shortLoanChanged || longLoanChanged) {
      toUpdate.push({ ...r, symbol: sym, fiscalYear: yr });
      changedSymbols.push(sym);
    }
  }

  if (toUpdate.length === 0) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO fundamentals_history (
        symbol, fiscal_year, period, eps_basic, eps_diluted, eps_quarterly,
        nav_per_share, paid_up_capital_mn, authorized_capital_mn,
        pe_ratio, pe_diluted, pe_trailing, dividend_yield, dps, debt_to_equity, current_ratio,
        net_income_mn, reserve_surplus_mn, oci_mn, short_term_loan_mn, long_term_loan_mn, bonus_pct,
        quarterly_disclosure, audit_status, source, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Provisional', ?, datetime('now'))
      ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
        period = excluded.period,
        eps_basic = excluded.eps_basic,
        eps_diluted = excluded.eps_diluted,
        eps_quarterly = excluded.eps_quarterly,
        nav_per_share = excluded.nav_per_share,
        paid_up_capital_mn = COALESCE(excluded.paid_up_capital_mn, fundamentals_history.paid_up_capital_mn),
        authorized_capital_mn = COALESCE(excluded.authorized_capital_mn, fundamentals_history.authorized_capital_mn),
        pe_ratio = excluded.pe_ratio,
        pe_diluted = excluded.pe_diluted,
        pe_trailing = excluded.pe_trailing,
        dividend_yield = excluded.dividend_yield,
        dps = COALESCE(excluded.dps, fundamentals_history.dps),
        debt_to_equity = excluded.debt_to_equity,
        current_ratio = excluded.current_ratio,
        net_income_mn = COALESCE(excluded.net_income_mn, fundamentals_history.net_income_mn),
        reserve_surplus_mn = COALESCE(excluded.reserve_surplus_mn, fundamentals_history.reserve_surplus_mn),
        oci_mn = COALESCE(excluded.oci_mn, fundamentals_history.oci_mn),
        short_term_loan_mn = COALESCE(excluded.short_term_loan_mn, fundamentals_history.short_term_loan_mn),
        long_term_loan_mn = COALESCE(excluded.long_term_loan_mn, fundamentals_history.long_term_loan_mn),
        bonus_pct = COALESCE(excluded.bonus_pct, fundamentals_history.bonus_pct),
        quarterly_disclosure = excluded.quarterly_disclosure,
        source = excluded.source,
        recorded_at = datetime('now')
      WHERE fundamentals_history.audit_status IS NOT 'Audited'
         OR fundamentals_history.source = 'STAGING_DB'
         OR fundamentals_history.net_income_mn IS NULL
         OR fundamentals_history.reserve_surplus_mn IS NULL
         OR fundamentals_history.short_term_loan_mn IS NULL
         OR fundamentals_history.long_term_loan_mn IS NULL
    `);

    for (const data of toUpdate) {
      stmt.run([
        data.symbol,
        data.fiscalYear,
        data.auditedPeriod || null,
        numOrNull(data.epsBasic) ?? numOrNull(data.eps),
        numOrNull(data.epsDiluted),
        numOrNull(data.epsQuarterly),
        numOrNull(data.navPerShare),
        numOrNull(data.paidUpCapitalMn) ?? numOrNull(data.paidUpCapital),
        numOrNull(data.authorizedCapitalMn) ?? numOrNull(data.authorizedCapital),
        numOrNull(data.peBasic) ?? numOrNull(data.pe),
        numOrNull(data.peDiluted),
        numOrNull(data.peTrailing),
        numOrNull(data.dividendYield),
        numOrNull(data.dps),
        numOrNull(data.debtToEquity),
        numOrNull(data.currentRatio),
        numOrNull(data.netIncomeMn ?? data.net_income_mn),
        numOrNull(data.reserveSurplusMn ?? data.reserve_surplus_mn),
        numOrNull(data.ociMn ?? data.oci_mn),
        numOrNull(data.shortTermLoanMn ?? data.short_term_loan_mn),
        numOrNull(data.longTermLoanMn ?? data.long_term_loan_mn),
        numOrNull(data.bonusPct ?? data.bonus_pct),
        data.quarterlyDisclosure || null,
        // Bound from data.source now (defaulting to 'DSE_OFFICIAL' when a
        // caller doesn't set it -- every current caller scrapes from
        // dsebd.org, so this preserves existing behavior exactly) rather
        // than hardcoded here regardless of the record's own source field.
        data.source || 'DSE_OFFICIAL'
      ]);
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));

    const compStmt = dbPrepare(`
      UPDATE company_list
      SET reserve_surplus_mn = COALESCE(?, reserve_surplus_mn),
          oci_mn = COALESCE(?, oci_mn),
          short_term_loan_mn = COALESCE(?, short_term_loan_mn),
          long_term_loan_mn = COALESCE(?, long_term_loan_mn)
      WHERE symbol = ?
    `);
    for (const data of toUpdate) {
      const resVal = numOrNull(data.reserveSurplusMn ?? data.reserve_surplus_mn);
      const ociVal = numOrNull(data.ociMn ?? data.oci_mn);
      const stVal = numOrNull(data.shortTermLoanMn ?? data.short_term_loan_mn);
      const ltVal = numOrNull(data.longTermLoanMn ?? data.long_term_loan_mn);
      if (resVal !== null || ociVal !== null || stVal !== null || ltVal !== null) {
        compStmt.run([resVal, ociVal, stVal, ltVal, data.symbol]);
      }
    }
    await new Promise((res, rej) => compStmt.finalize(err => err ? rej(err) : res()));

    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }

  return {
    total: records.length,
    changedCount: toUpdate.length,
    unchangedCount: records.length - toUpdate.length,
    changedSymbols
  };
}

export async function saveShareholdingCurrent(records) {
  if (!records || !Array.isArray(records) || records.length === 0) return { saved: 0 };
  if (!isSqliteAvailable) return { saved: 0 };

  let saved = 0;
  for (const r of records) {
    if (!r || !r.symbol || !r.shareholding?.current) continue;
    const cur = r.shareholding.current;
    const prev = r.shareholding.previous;
    await dbRun(
      `INSERT INTO shareholding_current (
         symbol, sponsor_pct, govt_pct, institute_pct, foreign_pct, public_pct, as_of_date,
         prev_sponsor_pct, prev_govt_pct, prev_institute_pct, prev_foreign_pct, prev_public_pct, prev_as_of_date,
         updated_at, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'DSE_OFFICIAL')
       ON CONFLICT(symbol) DO UPDATE SET
         sponsor_pct = excluded.sponsor_pct, govt_pct = excluded.govt_pct, institute_pct = excluded.institute_pct,
         foreign_pct = excluded.foreign_pct, public_pct = excluded.public_pct, as_of_date = excluded.as_of_date,
         prev_sponsor_pct = excluded.prev_sponsor_pct, prev_govt_pct = excluded.prev_govt_pct,
         prev_institute_pct = excluded.prev_institute_pct, prev_foreign_pct = excluded.prev_foreign_pct,
         prev_public_pct = excluded.prev_public_pct, prev_as_of_date = excluded.prev_as_of_date,
         updated_at = excluded.updated_at, source = excluded.source`,
      [
        String(r.symbol).toUpperCase().trim(),
        cur.sponsorPct, cur.govtPct, cur.institutePct, cur.foreignPct, cur.publicPct, cur.asOfDate,
        prev?.sponsorPct ?? null, prev?.govtPct ?? null, prev?.institutePct ?? null,
        prev?.foreignPct ?? null, prev?.publicPct ?? null, prev?.asOfDate ?? null,
      ]
    );
    saved++;
  }
  return { saved };
}

export async function saveDSEXDailyClosing(data, dateStr) {
  if (!data) return;
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  const dsexIndex = data.dsexIndex !== null && data.dsexIndex !== undefined && Number(data.dsexIndex) > 0
    ? Number(data.dsexIndex)
    : null;
  if (dsexIndex === null) {
    console.warn(`[SQLITE] saveDSEXDailyClosing: no real DSEX value for ${targetDate}, skipping write.`);
    return;
  }

  const existing = await dbGet(`SELECT source, dsex_index FROM dsex_market_history WHERE date = ?`, [targetDate]);
  if (!tierAllowsOverwrite(existing?.source, data.source)) {
    console.warn(`[SQLITE] saveDSEXDailyClosing: skipped for ${targetDate} -- existing row already has a better/equal-tier source.`);
    if (valueChanged(existing?.dsex_index, dsexIndex)) {
      await saveConflictToQuarantine({
        targetTable: 'dsex_market_history',
        recordIdentifier: targetDate,
        fieldName: 'dsex_index',
        existingValue: existing?.dsex_index,
        incomingValue: dsexIndex,
        existingSource: existing?.source,
        incomingSource: data.source,
        notes: 'saveDSEXDailyClosing: lower/equal-tier source reported a different DSEX index value than the stored value.'
      });
    }
    return;
  }

  await dbRun(`
    INSERT INTO dsex_market_history (
      date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      dsex_index = excluded.dsex_index,
      advancing = excluded.advancing,
      declining = excluded.declining,
      unchanged = excluded.unchanged,
      total_trades = excluded.total_trades,
      total_volume = excluded.total_volume,
      total_value_mn = excluded.total_value_mn,
      source = COALESCE(excluded.source, dsex_market_history.source)
  `, [
    targetDate,
    dsexIndex,
    data.advancing ?? null,
    data.declining ?? null,
    data.unchanged ?? null,
    data.totalTrades ?? null,
    data.totalVolume ?? null,
    data.totalValueMn ?? null,
    data.source || null
  ]);
}

export async function saveDS30DailyClosing(data, targetDate = null) {
  if (!isSqliteAvailable) return;
  if (!targetDate || !data) return;

  const ds30Index = positiveNumOrNull(data.ds30Index);
  if (ds30Index === null) {
    console.warn(`[SQLITE] saveDS30DailyClosing: no real DS30 value for ${targetDate}, skipping write.`);
    return;
  }

  // Tier-priority guard, added to match saveDSEXDailyClosing's same
  // protection -- previously this single-row write path had none.
  const existing = await dbGet(`SELECT source, ds30_index FROM ds30_index_history WHERE date = ?`, [targetDate]);
  if (!tierAllowsOverwrite(existing?.source, data.source)) {
    console.warn(`[SQLITE] saveDS30DailyClosing: skipped for ${targetDate} -- existing row already has a better/equal-tier source.`);
    if (valueChanged(existing?.ds30_index, ds30Index)) {
      await saveConflictToQuarantine({
        targetTable: 'ds30_index_history',
        recordIdentifier: targetDate,
        fieldName: 'ds30_index',
        existingValue: existing?.ds30_index,
        incomingValue: ds30Index,
        existingSource: existing?.source,
        incomingSource: data.source,
        notes: 'saveDS30DailyClosing: lower/equal-tier source reported a different DS30 index value than the stored value.'
      });
    }
    return;
  }

  await dbRun(`
    INSERT INTO ds30_index_history (date, ds30_index, prev_close, change_percent, source, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      ds30_index = excluded.ds30_index,
      prev_close = excluded.prev_close,
      change_percent = excluded.change_percent,
      source = COALESCE(excluded.source, ds30_index_history.source)
  `, [
    targetDate,
    ds30Index,
    data.prevClose ?? null,
    data.changePercent ?? null,
    data.source || null
  ]);
}

export async function saveCorporateAction({
  symbol,
  eventType,
  eventDate,
  recordDate = null,
  agmDate = null,
  cashDps = null,
  bonusPct = null,
  details = null,
  source = 'DSE_OFFICIAL',
  fiscalYear = null
}) {
  if (!symbol || !eventType || !eventDate) return null;
  const cleanSym = String(symbol).toUpperCase().trim();
  const cleanType = String(eventType).toUpperCase().trim();

  // ON CONFLICT upsert against the UNIQUE(symbol, event_type, event_date,
  // fiscal_year, cash_dps) constraint added 2026-09-01 -- this was previously
  // a plain INSERT with no dedup key at all, and the scraper that fed it
  // (scrapeLankaBDDividendArchive) was ungated and ran on every default CLI
  // invocation, duplicating rows on every rerun (confirmed live: 17,522 rows
  // for ~4,330 real events on the existing DB as of this fix). fiscal_year is
  // part of the key because two genuinely different real disclosures can
  // share a publish date (confirmed live against lankabd.com: AIL's FY2021
  // 10% and FY2020 5% cash dividends were both published 2021-11-10) --
  // event_date alone would silently conflate them. cash_dps is ALSO part of
  // the key because a smaller number of symbols have two real, differently-
  // valued disclosures sharing every other key column too (e.g. BATASHOE,
  // consistently reproduced across every historical scrape) -- see
  // ARCHITECTURE.md Known Incident #11 for the full finding. Known gap:
  // cash_dps is nullable and SQL UNIQUE treats every NULL as distinct from
  // every other, so two bonus-only (cash_dps IS NULL) events sharing every
  // other column won't be caught by this constraint alone.
  return await dbRun(`
    INSERT INTO corporate_actions_calendar (
      symbol, event_type, event_date, record_date, agm_date,
      cash_dps, bonus_pct, details, source, fiscal_year
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, event_type, event_date, fiscal_year, cash_dps) DO UPDATE SET
      record_date = excluded.record_date,
      agm_date = excluded.agm_date,
      bonus_pct = excluded.bonus_pct,
      details = excluded.details,
      source = excluded.source
  `, [
    cleanSym,
    cleanType,
    eventDate,
    recordDate,
    agmDate,
    cashDps,
    bonusPct,
    details,
    source,
    fiscalYear
  ]);
}

export async function saveCorporateActionsBatch(events = []) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  let saved = 0;
  let failed = 0;
  for (const ev of events) {
    if (ev.symbol && ev.eventType && ev.eventDate) {
      try {
        await saveCorporateAction(ev);
        saved++;
      } catch (err) {
        failed++;
        if (failed <= 5) {
          console.warn(`[SQLITE] saveCorporateActionsBatch: skipped ${ev.symbol}/${ev.eventType}/${ev.eventDate} -- ${err.message}`);
        }
      }
    }
  }
  if (failed > 0) {
    console.warn(`[SQLITE] saveCorporateActionsBatch: ${failed} of ${events.length} record(s) failed to save (see warnings above for the first 5).`);
  }
  return saved;
}
