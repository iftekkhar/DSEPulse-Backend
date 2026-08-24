/**
 * The approved source list -- every value this system stores must trace to one
 * of these, and to nothing else. See ARCHITECTURE.md's Core Principle. Adding a
 * new source means adding it here FIRST, as a deliberate decision, not
 * discovering after the fact that an unapproved source has been writing data.
 *
 * Tier 1 -- DSE official. Scraped or promoted directly from dsebd.org.
 *   DSE_OFFICIAL_GRAPH added 2026-08-23: dsebd.org's own chart-data endpoint
 *   (php_graph/monthly_graph_index.php?type=dseX&duration=N), a real DSEX
 *   history feed distinct from day_end_archive.php/recent_market_information.php
 *   -- verified live, its 2026-08-20 value matched the already-confirmed
 *   recent_market_information.php value exactly. Covers 2013 (when DSEX itself
 *   was introduced) through present, i.e. the full range currently split across
 *   DSE_OFFICIAL_ARCHIVE/BENCHMARK and the two Tier 3 estimate sources below.
 * Tier 2 -- LankaBangla. The approved secondary real-data source.
 * Tier 3 -- Approved supplementary/derived. Real data, grounded in a real
 *   dataset or a real computation over real inputs, but not itself DSE- or
 *   LankaBangla-original. Currently: KAGGLE (a compiled historical dataset,
 *   used in a few remaining stg_price_history rows). Approving a Tier 3 source
 *   is a per-instance review, not a standing license -- MCAP_WEIGHTED_ESTIMATE
 *   was approved 2026-08-22 for a specific batch of stg_index_history rows,
 *   then removed 2026-08-23 after investigating all 57: 49 were dated on
 *   Friday/Saturday (DSE's actual weekend -- structurally not trading days),
 *   and the remaining 8 showed 18-28% swings that fully reverted within days,
 *   which no real index does. The rows were deleted rather than kept under an
 *   "approved" label neither the market-closure evidence nor the values
 *   themselves supported. This entry is removed rather than left approved-but-
 *   unused: an unused approval with its original justification gone is stale
 *   documentation, not a safety margin. Re-adding it requires the same fresh
 *   review as any new source.
 */
export const SOURCE_TIERS = {
  DSE_OFFICIAL_ARCHIVE: 1,
  DSE_OFFICIAL_BENCHMARK: 1,
  DSE_OFFICIAL_GRAPH: 1,
  DSE_SCRAPE: 1,
  DSE_OFFICIAL: 1,
  DSE_LIVE_CLOSING: 1,
  DSE_LIVE_TICKER: 1,
  LANKABD: 2,
  KAGGLE: 3,
  // Main-DB-only source, added 2026-08-23: every row main DB receives via
  // promotion is tagged this way regardless of which specific tier staging
  // used internally (DSE_SCRAPE/LANKABD/DSE_OFFICIAL_GRAPH/etc.) -- from main
  // DB's perspective, "passed staging's audit + promotion gate" is itself the
  // trust signal, and staging is declared Tier 1 for that purpose. Staging's
  // OWN internal tables still track the granular tier (needed there for
  // tierAllowsOverwrite to arbitrate between competing staging scrapers) --
  // this label only replaces it at the point data crosses into main DB.
  // Never used by any live server/ scraper, which tags its own writes with
  // its own live source (DSE_LIVE_CLOSING/DSE_LIVE_TICKER/DSE_OFFICIAL) so
  // live rows stay distinguishable from promoted ones.
  STAGING_DB: 1,
};

export function tierOf(source) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TIERS, source) ? SOURCE_TIERS[source] : null;
}

export function isApprovedSource(source) {
  return tierOf(source) !== null;
}

/**
 * Tier-priority write guard (ARCHITECTURE.md item 5, 2026-08-22). Both
 * server.closing_prices/pipeline.eod_settlement (main DB) and
 * gap_scraper.js/lankabd_scraper.js (staging DB) can independently write the
 * same (symbol, date) -- without this, whichever writes second wins
 * unconditionally, including on `source`, so a Tier 1 direct scrape can get
 * silently overwritten by a lower-tier one (or vice versa) depending purely on
 * request timing. This was not hypothetical: the first live run of
 * lankabd_scraper.js against the 244 newly-added bond/T-bill/fund instruments
 * overwrote ~8,160 real DSE_SCRAPE rows in the overlapping date range before
 * this guard existed.
 *
 * Never blocks on a missing/unrecognized tier on either side -- only a KNOWN
 * worse tier is refused, so an untiered write still lands rather than
 * silently vanishing.
 */
export function tierAllowsOverwrite(existingSource, incomingSource) {
  const existingTier = tierOf(existingSource);
  const incomingTier = tierOf(incomingSource);
  if (existingTier === null || incomingTier === null) return true;
  return incomingTier <= existingTier;
}

/**
 * Which `source` values each promotion payload is authoritative for, keyed by
 * main-DB table. Used to scope the promoter's orphan-row cleanup (2026-08-23,
 * see ARCHITECTURE.md) so it can only ever delete rows the staging pipeline
 * itself produced -- never a row server/'s own live cron jobs wrote directly
 * (DSE_LIVE_CLOSING, DSE_LIVE_TICKER), which promotion has no visibility into
 * and must never be able to touch, regardless of what staging currently
 * contains or when the sync happens to run relative to a live write.
 * MCAP_WEIGHTED_ESTIMATE is listed defensively even though no longer an
 * approved source (removed 2026-08-23) -- any leftover row under that label
 * anywhere is still something promotion should be able to clean up.
 */
// Updated 2026-08-23: promoted rows are now tagged STAGING_DB uniformly (see
// SOURCE_TIERS above), not the granular per-scraper tier they carried before
// -- so this is what the prune functions scope against now. A row still
// carrying an old per-scraper tier label (a pre-2026-08-23 leftover) would
// get overwritten (and re-tagged STAGING_DB) the next time its own key is
// re-promoted -- but NOT pruned as an orphan: the prune functions' own
// candidate query filters to `source IN (...)` this list first, so an
// old-tier-labeled row is excluded from that candidate set entirely and
// would never be selected for deletion even if genuinely orphaned. As of
// 2026-08-23 this is moot in practice (main DB is 100% STAGING_DB across all
// 4 promoted tables, confirmed via npm run audit:main-db), but the
// distinction matters if an old-tagged row is ever reintroduced by a bug.
export const PROMOTION_OWNED_SOURCES = {
  price_history: ['STAGING_DB'],
  dsex_market_history: ['STAGING_DB'],
  fundamentals_history: ['STAGING_DB'],
  company_list: ['STAGING_DB'],
};
