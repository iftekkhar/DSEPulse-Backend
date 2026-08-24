/**
 * DSE's per-year fundamentals tables (displayCompany.php) lay out each numeric
 * column in fixed 3-cell groups: Original, Restated, Diluted. A company with no
 * discontinued operations to report separately leaves the headline group
 * entirely dashed and only populates the Continuing-Operations group -- so a
 * value has to be read from whichever group actually has one, headline taking
 * priority when both do. Within a populated group, "Restated" (when present)
 * supersedes "Original", so the LAST non-dash cell in the group wins.
 *
 * This was originally pipeline/src/scrapers/fundamentals_scraper.js-only logic,
 * tested there (shared/test_suite.js section 13) against real DSE table shapes
 * confirmed live across an IT company, a consumer blue-chip, and a bank. Moved
 * here 2026-08-23 so server/scrapers/audited_eps_scraper.js -- the scraper that
 * actually runs in production every day now that pipeline/ is dev-only (see
 * ARCHITECTURE.md) -- uses the same tested resolution instead of its own
 * simpler nums[0]/nums[1] heuristic, which had no headline-vs-continuing-ops
 * disambiguation and no restated-supersedes-original handling. pipeline/'s own
 * copy is left as-is (out of scope for a backend-only change); this is the one
 * both server/ and shared/test_suite.js now import from.
 */

// Last non-dash numeric value within a fixed 3-cell (Original/Restated/Diluted)
// group -- "last wins" so a Restated figure supersedes Original when both exist.
export function lastNumberInGroup(cells, startIdx) {
  let val = null;
  for (let i = startIdx; i < startIdx + 3 && i < cells.length; i++) {
    const v = parseFloat(String(cells[i]).replace(/,/g, ''));
    if (!Number.isNaN(v)) val = v;
  }
  return val;
}

// Headline group first (cells[0-2]), falling back to Continuing-Operations
// (cells[3-5]) when the headline group is entirely dashed -- the normal case for
// any company with no discontinued operations to report separately.
export function headlineOrContinuing(cells) {
  return lastNumberInGroup(cells, 0) ?? lastNumberInGroup(cells, 3);
}
