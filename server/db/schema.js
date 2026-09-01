import { dbRun, dbGet, applyPragmas } from './connection.js';

// Initialize Tables & Covering Indexes across all 24 schema tables
export async function initDB() {
  await applyPragmas();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      ycp REAL,
      change REAL,
      change_percent REAL,
      volume INTEGER,
      value_mn REAL,
      pe REAL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date)
    );
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_symbol_date ON price_history(symbol, date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_date ON price_history(date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_cov ON price_history(symbol, date DESC, close, ycp, change, change_percent, volume, pe);`);
  try { await dbRun(`ALTER TABLE price_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE price_history ADD COLUMN trades INTEGER;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE price_history ADD COLUMN market_cap_mn REAL;`); } catch { /* column exists */ }

  // Block Market transactions table (Tier 1 DSE / Tier Two LankaBD)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS block_market_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      trades INTEGER,
      quantity INTEGER,
      value_mn REAL,
      min_price REAL,
      max_price REAL,
      source TEXT DEFAULT 'LANKABD',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_block_symbol_date ON block_market_history(symbol, date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_block_date ON block_market_history(date DESC);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dsex_market_history (
      date TEXT PRIMARY KEY,
      dsex_index REAL NOT NULL,
      advancing INTEGER,
      declining INTEGER,
      unchanged INTEGER,
      total_trades INTEGER,
      total_volume INTEGER,
      total_value_mn REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dsex_hist_date ON dsex_market_history(date DESC);`);
  try { await dbRun(`ALTER TABLE dsex_market_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }

  // DS30 (blue-chip index) daily level
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ds30_index_history (
      date TEXT PRIMARY KEY,
      ds30_index REAL NOT NULL,
      prev_close REAL,
      change_percent REAL,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_ds30_hist_date ON ds30_index_history(date DESC);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS fundamentals_history (
      symbol TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      period TEXT,
      eps_basic REAL,
      eps_diluted REAL,
      nav_per_share REAL,
      roe REAL,
      dividend_yield REAL,
      paid_up_capital_mn REAL,
      authorized_capital_mn REAL,
      pe_ratio REAL,
      debt_to_equity REAL,
      current_ratio REAL,
      audit_status TEXT DEFAULT 'Audited',
      recorded_at TEXT,
      PRIMARY KEY (symbol, fiscal_year)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_fund_hist_sym ON fundamentals_history(symbol, fiscal_year DESC);`);
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN eps_quarterly REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN pe_diluted REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN pe_trailing REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN quarterly_disclosure TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN dps REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN net_income_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN reserve_surplus_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN oci_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN short_term_loan_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN long_term_loan_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN bonus_pct REAL;`); } catch { /* column exists */ }
  
  // Phase 2: PDF Financial Statement Line Items
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN revenue_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN gross_profit_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN operating_profit_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN total_assets_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN total_liabilities_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN current_assets_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN current_liabilities_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN capex_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN operating_cash_flow_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN free_cash_flow_mn REAL;`); } catch { /* column exists */ }

  // Mirrors stg_company_list exactly
  await dbRun(`
    CREATE TABLE IF NOT EXISTS company_list (
      symbol            TEXT PRIMARY KEY,
      name              TEXT,
      sector            TEXT,
      category          TEXT,
      listing_date      TEXT,
      face_value        REAL DEFAULT 10.0,
      total_shares      INTEGER,
      market_cap_mn     REAL,
      is_active         INTEGER DEFAULT 1,
      fetched_at        TEXT NOT NULL,
      source            TEXT
    );
  `);
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN source TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN asset_class TEXT DEFAULT 'Equity';`); } catch { /* column exists */ }
  // DS30 blue-chip index membership flag (was live in production DBs without
  // ever being declared here -- server/db/analytics_repo.js and
  // server/auditors/audit_main_database.js both read company_list.ds30, so a
  // fresh DB built from this file alone would crash on that column reference).
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN ds30 INTEGER DEFAULT 0;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN reserve_surplus_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN oci_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN short_term_loan_mn REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN long_term_loan_mn REAL;`); } catch { /* column exists */ }
  
  // Category transition tracking
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN prev_category TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN category_changed_at TEXT;`); } catch { /* column exists */ }

  // New listing tracking
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN is_new_listing INTEGER DEFAULT 0;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN first_scraped_at TEXT;`); } catch { /* column exists */ }

  // Delisting & trading status tracking
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN trading_status TEXT DEFAULT 'Active';`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN delisted_date TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN last_traded_date TEXT;`); } catch { /* column exists */ }

  // DS30 index reconstitution transition tracking
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN prev_ds30 INTEGER DEFAULT 0;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN ds30_changed_at TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN ds30_added_at TEXT;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN ds30_removed_at TEXT;`); } catch { /* column exists */ }

  // Institutional Credit Ratings Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS credit_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      rating_agency TEXT,
      long_term_rating TEXT,
      short_term_rating TEXT,
      outlook TEXT,
      rating_date TEXT,
      valid_until TEXT,
      rating_action TEXT,
      source TEXT DEFAULT 'DSE_OFFICIAL',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, rating_date, rating_agency)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_credit_rating_sym ON credit_ratings(symbol, rating_date DESC);`);

  // Sponsor/Director Share Lock-in Details Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS share_lockins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      lockin_category TEXT,
      quantity INTEGER,
      release_date TEXT,
      source TEXT DEFAULT 'DSE_OFFICIAL',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, lockin_category, release_date)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_share_lockins_sym ON share_lockins(symbol, release_date DESC);`);

  // Auto-Categorize Fixed Income Securities
  try {
    await dbRun(`
      UPDATE company_list
      SET asset_class = 'Fixed Income',
          sector = CASE 
            WHEN symbol LIKE 'TB%' THEN 'Govt Treasury Bond'
            WHEN symbol LIKE '%SUKUK%' THEN 'Sukuk'
            WHEN symbol LIKE '%DEB%' THEN 'Debenture'
            ELSE 'Corporate Bond'
          END,
          category = CASE
            WHEN symbol LIKE 'TB%' THEN 'Govt Bond'
            WHEN symbol LIKE '%SUKUK%' THEN 'Sukuk'
            ELSE 'Bond'
          END
      WHERE (sector IS NULL OR sector = '' OR asset_class = 'Fixed Income')
        AND (symbol LIKE 'TB%' OR symbol LIKE '%BOND%' OR symbol LIKE '%SUKUK%' OR symbol LIKE '%DEB%');
    `);
  } catch { /* ignore */ }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at            TEXT NOT NULL,
      target_entity     TEXT NOT NULL,
      records_audited   INTEGER NOT NULL,
      errors_count      INTEGER NOT NULL,
      warnings_count    INTEGER NOT NULL,
      status            TEXT NOT NULL,
      report_json       TEXT
    );
  `);

  // Auth, entitlements, payments
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id   TEXT UNIQUE NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id       INTEGER PRIMARY KEY REFERENCES users(id),
      premium_until TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_watchlist (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      symbol    TEXT NOT NULL,
      added_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, symbol)
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      gateway         TEXT NOT NULL,
      gateway_txn_id  TEXT UNIQUE,
      amount_bdt      INTEGER NOT NULL,
      status          TEXT NOT NULL,
      plan            TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code        TEXT PRIMARY KEY,
      bonus_days  INTEGER NOT NULL,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);
  try { await dbRun(`ALTER TABLE promo_codes ADD COLUMN bonus_hours INTEGER DEFAULT 0;`); } catch { /* column exists */ }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      code         TEXT NOT NULL REFERENCES promo_codes(code),
      redeemed_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, code)
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id  INTEGER NOT NULL REFERENCES users(id),
      action         TEXT NOT NULL,
      detail_json    TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  await dbRun(`INSERT OR IGNORE INTO promo_codes (code, bonus_days, active) VALUES ('PULSE24', 1, 1)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS scraper_settings (
      scraper_key  TEXT PRIMARY KEY,
      enabled      INTEGER NOT NULL,
      updated_at   TEXT DEFAULT (datetime('now')),
      updated_by   INTEGER REFERENCES users(id)
    );
  `);

  // Persistent job/scraper run telemetry (2026-09-01) -- current-state row per
  // scraper_registry.js key (plus synthetic keys like '_masterCycle' for
  // composite jobs with no single registry key of their own). Survives a
  // restart/deploy, unlike the in-memory jobStatusRegistry in
  // server/cron_scheduler.js this complements. See server/db/job_status_repo.js.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS job_run_status (
      job_key          TEXT PRIMARY KEY,
      last_run_at      TEXT,
      last_success_at  TEXT,
      last_status      TEXT,
      last_error       TEXT,
      last_result_json TEXT,
      success_count    INTEGER NOT NULL DEFAULT 0,
      failure_count    INTEGER NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key  TEXT PRIMARY KEY,
      value_json   TEXT NOT NULL,
      updated_at   TEXT DEFAULT (datetime('now')),
      updated_by   INTEGER REFERENCES users(id)
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS shareholding_current (
      symbol          TEXT PRIMARY KEY,
      sponsor_pct     REAL,
      govt_pct        REAL,
      institute_pct   REAL,
      foreign_pct     REAL,
      public_pct      REAL,
      as_of_date      TEXT,
      prev_sponsor_pct   REAL,
      prev_govt_pct      REAL,
      prev_institute_pct REAL,
      prev_foreign_pct   REAL,
      prev_public_pct    REAL,
      prev_as_of_date    TEXT,
      updated_at      TEXT DEFAULT (datetime('now')),
      source          TEXT
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS data_quarantine (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      target_table        TEXT NOT NULL,
      record_identifier   TEXT NOT NULL,
      field_name          TEXT NOT NULL,
      existing_value      TEXT,
      incoming_value      TEXT,
      live_verified_value TEXT,
      existing_source     TEXT,
      incoming_source     TEXT,
      status              TEXT DEFAULT 'PENDING_USER_APPROVAL',
      notes               TEXT
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_quarantine_status ON data_quarantine(status, created_at DESC);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS valuation_daily_cache (
      symbol                  TEXT PRIMARY KEY,
      close                   REAL,
      market_cap_mn           REAL,
      graham_number           REAL,
      peter_lynch_fair_value  REAL,
      ddm_fair_value          REAL,
      dcf_intrinsic_value     REAL,
      blended_target          REAL,
      margin_of_safety_pct    REAL,
      valuation_verdict       TEXT,
      debt_to_equity          REAL,
      piotroski_score         INTEGER,
      moat_rating             TEXT,
      volatility_annualized   REAL,
      beta                    REAL,
      sharpe_ratio            REAL,
      volume_velocity         REAL,
      eps_cagr_5y             REAL,
      navps_cagr_5y           REAL,
      dps_cagr_5y             REAL,
      dividend_yield          REAL,
      payout_ratio            REAL,
      updated_at              TEXT NOT NULL
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_val_cache_verdict ON valuation_daily_cache(valuation_verdict);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_val_cache_moat ON valuation_daily_cache(moat_rating);`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corporate_actions_calendar (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      event_date    TEXT NOT NULL,
      record_date   TEXT,
      agm_date      TEXT,
      cash_dps      REAL,
      bonus_pct     REAL,
      details       TEXT,
      source        TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      fiscal_year   INTEGER,
      UNIQUE(symbol, event_type, event_date, fiscal_year, cash_dps)
    );
  `);
  // fiscal_year added after the table already existed on some DBs -- guarded
  // for those (CREATE TABLE IF NOT EXISTS is a no-op when the table already
  // exists, so the column above never lands there without this).
  try { await dbRun(`ALTER TABLE corporate_actions_calendar ADD COLUMN fiscal_year INTEGER;`); } catch { /* column exists */ }
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_actions_date ON corporate_actions_calendar(event_date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_actions_sym ON corporate_actions_calendar(symbol, event_date DESC);`);
  // Retrofits the UNIQUE(symbol, event_type, event_date, fiscal_year)
  // constraint above onto a DB that created this table before the constraint
  // existed (CREATE TABLE IF NOT EXISTS is a no-op there) --
  // scrapeLankaBDDividendArchive() was previously ungated and re-ran
  // unconditionally on every default CLI invocation of
  // scrape_historical_financial_statements.js, duplicating rows on every
  // rerun. fiscal_year is part of the key (not just symbol/event_type/date)
  // because two GENUINELY DIFFERENT real disclosures can share a publish
  // date -- confirmed live against lankabd.com during the 2026-09-01 cleanup
  // (e.g. AIL's FY2021 10% and FY2020 5% cash dividends were both published
  // 2021-11-10); a 3-column key would have silently conflated them. Guarded:
  // if this DB still has rows sharing the full 4-column key after the
  // migration in ARCHITECTURE.md's Known Incident #11 addendum ran (a small
  // number of genuinely ambiguous same-fiscal-year disclosure conflicts were
  // deliberately left unresolved rather than guessed at), index creation
  // fails and is caught here rather than blocking boot.
  // cash_dps is also part of the key (not just symbol/event_type/date/
  // fiscal_year) -- found live 2026-09-01 during cleanup: a small number of
  // symbols (BATASHOE, etc.) have TWO real, differently-valued dividend
  // disclosures that share the same symbol/event_type/event_date/fiscal_year
  // (e.g. one row with agm_date set + cash_dps=248, another with record_date
  // set + cash_dps=105 -- consistently reproduced across every historical
  // scrape run, not scraper noise). Excluding cash_dps from the key would
  // have forced picking one value and silently discarding the other real
  // one. Known residual gap: cash_dps is nullable, and SQL UNIQUE treats
  // every NULL as distinct from every other NULL, so two bonus-only
  // (cash_dps IS NULL) events sharing every other key column would not be
  // deduplicated by this constraint alone -- accepted as a narrower, less
  // consequential gap than the alternative of silently losing real data.
  try {
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_corp_actions_dedup ON corporate_actions_calendar(symbol, event_type, event_date, fiscal_year, cash_dps);`);
  } catch (err) {
    console.warn('[SCHEMA] corporate_actions_calendar dedup index not created (pre-existing duplicate or ambiguous rows) -- see ARCHITECTURE.md Known Incident #11:', err.message);
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS macro_indicators (
      indicator_key TEXT PRIMARY KEY,
      value         REAL NOT NULL,
      as_of_date    TEXT NOT NULL,
      source        TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`
    INSERT OR IGNORE INTO macro_indicators (indicator_key, value, as_of_date, source, updated_at)
    VALUES
      ('BANGLADESH_364D_TBILL', 0.1037, '2026-08-27', 'BANGLADESH_BANK_VIA_LANKABD', datetime('now')),
      ('BANGLADESH_ERP', 0.0550, '2026-08-27', 'DAMODARAN_FRONTIER_ERP', datetime('now')),
      ('BANGLADESH_TERMINAL_GROWTH', 0.0400, '2026-08-27', 'MACRO_LONG_TERM_GDP', datetime('now'));
  `);

  // One-time cleanup for malformed timestamp-shaped dates that an old bug
  // could insert into price_history.date (should hold plain YYYY-MM-DD).
  // Was an unconditional full-table scan (1M+ rows) on every single boot --
  // gated behind a persisted flag (2026-09-01) so a confirmed-clean DB skips
  // the scan on every subsequent restart instead of repeating it forever.
  const priceDateCleanupDone = await dbGet(
    `SELECT 1 FROM app_settings WHERE setting_key = '_malformed_price_dates_cleaned'`
  ).catch(() => null);
  if (!priceDateCleanupDone) {
    await dbRun(`DELETE FROM price_history WHERE date LIKE '%T%' OR date LIKE '%:%'`).catch(() => {});
    await dbRun(
      `INSERT OR IGNORE INTO app_settings (setting_key, value_json, updated_at) VALUES ('_malformed_price_dates_cleaned', 'true', datetime('now'))`
    ).catch(() => {});
  }
}
