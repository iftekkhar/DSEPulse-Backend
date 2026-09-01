/**
 * Static source-code fabrication audit for the backend (server/) and its
 * shared foundation (shared/). Complements the data-level auditors
 * (shared/data_auditor.js for record-level validation,
 * server/auditors/audit_main_database.js for the main DB as a whole) by
 * catching bad patterns in the CODE before they ever produce bad data -- see
 * ARCHITECTURE.md for the full rationale, including the canonical null/number
 * rule this enforces:
 *   1. Never `||` for a numeric fallback -- always `??` (or a shared/safe_number.js
 *      helper). `||` treats a real 0 the same as missing data.
 *   2. The fallback is `null`, never a fabricated 0/constant/other field.
 *   3. `?? 0` only for a loop-local sum accumulator, never a stored/returned field.
 *
 * Three tiers, same errors/warnings split used everywhere else in this project:
 *   - ERRORS: patterns with no legitimate use in this codebase. Every real instance
 *     found this session (Math.random/sin/cos-based synthesis, `?? someVar.close` as a
 *     fallback for a different field) turned out to be an actual fabrication bug, not a
 *     false positive -- so these block CERTIFIED_PASSED outright.
 *   - WARNINGS: `|| 0` / `?? 0`, which IS sometimes legitimate (e.g. summing a possibly-
 *     sparse array, a retry counter). This tool can't reliably tell that apart from a
 *     fabricated fallback on a real data field by regex alone, so it reports every
 *     instance for a human to triage rather than guessing -- the same manual-grep-then-
 *     eyeball workflow used throughout this project's fabrication audits, just automated
 *     and repeatable instead of ad hoc. Also warning-tier: `!== undefined` without a
 *     matching `!== null` on the same line -- the exact shape of the fundamentals_history
 *     incident (Number(null) is 0, so this "null check" lets a real null through).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// scripts/ added 2026-08-23: the CSV-fabrication bug in
// scripts/export_job1_csv.js (open ?? ycp, high/low ?? close -- exactly the
// "borrow another field's value" pattern the ERROR_PATTERNS below exist to
// catch) sat undetected for as long as it did specifically because this
// directory was never scanned, despite scripts/ writing files the API serves
// directly (/api/download/job1-price-history).
const SCAN_DIRS = ['server', 'shared', 'scripts'];

// This tool's own source (and its sibling data-auditors/canonical helpers)
// legitimately contains the pattern strings being searched for -- exclude audit
// tooling and the canonical implementations themselves from the scan.
const EXCLUDE_FILES = [
  'shared/code_audit.js',
  'server/auditors/audit_main_database.js',
  'shared/data_auditor.js',
  'shared/safe_number.js',
  'shared/test_suite.js',
];

const ERROR_PATTERNS = [
  { name: 'Math.random() synthesis', regex: /Math\.random\s*\(/g },
  { name: 'Math.sin() curve-fit synthesis', regex: /Math\.sin\s*\(/g },
  { name: 'Math.cos() curve-fit synthesis', regex: /Math\.cos\s*\(/g },
  // Narrowly targets the actual historical bug (ycp defaulting to a same-day price
  // field, which silently fabricates a 0% change or an "unchanged" classification)
  // by requiring "ycp" on the same line -- NOT a blanket ban on `?? close`/`|| close`,
  // which has legitimate uses (e.g. resolving which of several source-specific
  // aliases -- ltp/close/closePrice -- holds today's own close price; or a
  // technical indicator using close as a same-day proxy when a separate high/low
  // wasn't recorded). Checks both `??` and `||` -- the first live instance found
  // used `??` (r.ycp ?? r.close in a save path); a second, independently-found
  // instance used `||` (r.ycp || r.close inline in a breadth-classification
  // comparison) -- and both `close` and `ltp` as the fallback target, since either
  // one represents "today's price" being smuggled in as "yesterday's price."
  { name: 'ycp defaulted to a same-day price field (silently fabricates 0% change / false "unchanged")', regex: /ycp/i, secondaryRegex: /(\?\?|\|\|)\s*[\w.]*(close|ltp)\b/i },
];

const WARNING_PATTERNS = [
  { name: '`|| 0` fallback', regex: /\|\|\s*0\b(?!\.\d)/g },
  { name: '`?? 0` fallback', regex: /\?\?\s*0\b(?!\.\d)/g },
  // The exact shape of the fundamentals_history incident (see ARCHITECTURE.md):
  // `x !== undefined ? ... : fallback` looks like a null-check but isn't one --
  // `null !== undefined` is true in JS, so a real null sails through the `?` branch
  // and `Number(null)` silently becomes 0. A line with `!== undefined` that does
  // NOT also check `!== null` on the same line is this bug's exact fingerprint.
  // Warning-tier (not a hard error) because a handful of legitimate "was this
  // optional argument passed at all" checks exist that have nothing to do with
  // nullable data fields -- a human can tell those apart at a glance faster than
  // this regex can.
  { name: '`!== undefined` without `!== null` -- may silently let null through (Number(null) is 0)', regex: /!==\s*undefined\b/g, mustNotMatch: /!==\s*null\b/ },
];

// Catches the exact class of bug found 2026-09-01: scrapeLankaBDDividendArchive()
// had no isScraperEnabled() gate at all (no registry key, no check in its own
// body) and ran unconditionally on every default CLI invocation of its file,
// duplicating ~13,000 rows before anyone noticed. The existing "every
// registered scraper defaults off" test (shared/test_suite.js) can only see
// scrapers that ARE registered -- it has no way to notice one that was never
// added to the registry in the first place. This check closes that blind
// spot from the other direction: every exported `scrape*`-named function
// under server/scrapers/ must call isScraperEnabled( somewhere in its own
// body (per ARCHITECTURE.md: "gated at its function entry point (not just at
// one caller)"). A narrow, deliberately-named-convention check -- it only
// looks at functions actually named scrape*, not every exported function --
// to avoid false positives on unrelated helpers (fetchX, parseX, etc.).
const SCRAPER_FN_REGEX = /export\s+(?:async\s+)?function\s+(scrape\w*)\s*\(/g;

// Explicit, individually-justified exceptions -- shared low-level "fetch and
// parse ONE thing" helpers that are deliberately NOT gated at their own entry
// point because every one of their actual callers already is (verified by
// tracing every call site, not assumed). Keeping this list short and named
// (rather than loosening the check to a warning) means a genuinely new
// ungated scraper -- the exact shape of the scrapeLankaBDDividendArchive
// incident this check exists to catch -- still hard-fails CERTIFIED_PASSED
// instead of being silently swallowed alongside these known-safe exceptions.
// Adding to this list is a deliberate decision, same bar as adding to
// shared/source_tiers.js -- verify every call site is gated before adding.
const UNGATED_SCRAPER_HELPER_EXCEPTIONS = new Set([
  // server/scrapers/scrape_historical_financial_statements.js -- called only
  // from scrapeFundamentalsForAll() (gated: historical.fundamentals_scraper)
  // and fillFundamentalsGap() (gated: historical.gap_scraper_fundamentals).
  'scrapeCompanyFundamentals',
  // server/scrapers/sources/ds30_index_scraper.js -- no DB write of its own;
  // called only from dse_closing_scraper.js's runDailyClosingPricesScraper(),
  // itself gated (server.closing_prices), which additionally re-checks
  // isScraperEnabled('server.ds30_index') before calling this.
  'scrapeDs30IndexLevel',
  // server/scrapers/sources/dse_fundamentals_scraper.js -- called only from
  // runDailyFundamentalsDeltaScraper() (gated: server.fundamentals_delta or
  // server.fundamentals_weekly, whichever key it's invoked with).
  'scrapeCompanyAuditedFinancials',
]);

// Finds a function's body by first skipping past its ENTIRE parameter list
// via paren-depth counting (not just the first '('), then brace-matching from
// the body's real opening '{'. Naively taking the first '{' after the
// function name breaks on the very common `function f({ a = {} } = {})`
// destructured-default-params shape -- it grabs a param's braces instead of
// the body's, produces a truncated/wrong "body", and false-positives on a
// scraper that's actually gated (confirmed live: this exact bug initially
// misflagged scrapeBlockMarket/scrapeCompanyList/scrapePdfFinancialStatements/
// scrapeFundamentalsForAll, all of which destructure an options param).
function findFunctionBody(content, matchIndex, matchedText) {
  const parenStart = content.indexOf('(', matchIndex + matchedText.length - 1);
  if (parenStart === -1) return null;
  let parenDepth = 0;
  let closeParenIdx = -1;
  for (let i = parenStart; i < content.length; i++) {
    if (content[i] === '(') parenDepth++;
    else if (content[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { closeParenIdx = i; break; }
    }
  }
  if (closeParenIdx === -1) return null;

  const braceStart = content.indexOf('{', closeParenIdx + 1);
  if (braceStart === -1) return null;
  let braceDepth = 0;
  for (let i = braceStart; i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    else if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) return content.slice(braceStart, i + 1);
    }
  }
  return null;
}

function checkUngatedScrapers(absPath, relPath, content) {
  if (!relPath.startsWith('server' + path.sep + 'scrapers' + path.sep) && relPath !== path.join('server', 'scrapers')) return [];
  const errors = [];
  SCRAPER_FN_REGEX.lastIndex = 0;
  let match;
  while ((match = SCRAPER_FN_REGEX.exec(content))) {
    const fnName = match[1];
    if (UNGATED_SCRAPER_HELPER_EXCEPTIONS.has(fnName)) continue;
    const body = findFunctionBody(content, match.index, match[0]);
    if (body === null) continue; // unbalanced braces -- don't guess, skip rather than false-positive
    if (!body.includes('isScraperEnabled(')) {
      const line = content.slice(0, match.index).split('\n').length;
      errors.push({
        file: relPath,
        line,
        pattern: 'Ungated scraper (no isScraperEnabled() check in function body)',
        text: `export function ${fnName}(...) -- add an isScraperEnabled('<registry.key>') guard at the top of this function, matching every other scrape* function in this codebase`,
      });
    }
  }
  return errors;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function scanFile(absPath) {
  const relPath = path.relative(REPO_ROOT, absPath);
  if (EXCLUDE_FILES.includes(relPath)) return { errors: [], warnings: [] };

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const errors = [];
  const warnings = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    // Skip comment-only lines. This codebase documents past fabrication fixes
    // inline (e.g. "not `|| 0`: this used to..."), and those explanations
    // legitimately contain the exact banned pattern as a quoted example --
    // scanning them as if they were live code would flag the fix's own
    // documentation as a violation.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    for (const { name, regex, secondaryRegex } of ERROR_PATTERNS) {
      regex.lastIndex = 0;
      const primaryHit = regex.test(line);
      const hit = secondaryRegex ? (primaryHit && secondaryRegex.test(line)) : primaryHit;
      if (hit) errors.push({ file: relPath, line: idx + 1, pattern: name, text: trimmed });
    }
    for (const { name, regex, mustNotMatch } of WARNING_PATTERNS) {
      regex.lastIndex = 0;
      const hit = regex.test(line) && !(mustNotMatch && mustNotMatch.test(line));
      if (hit) warnings.push({ file: relPath, line: idx + 1, pattern: name, text: trimmed });
    }
  });

  errors.push(...checkUngatedScrapers(absPath, relPath, content));

  return { errors, warnings };
}

export function auditCode() {
  console.log('\n======================================================');
  console.log('   BACKEND SOURCE CODE FABRICATION AUDIT');
  console.log(`   Scanning: ${SCAN_DIRS.join(', ')}`);
  console.log('======================================================\n');

  let allErrors = [];
  let allWarnings = [];
  let filesScanned = 0;

  for (const dir of SCAN_DIRS) {
    const fullDir = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    for (const file of walk(fullDir)) {
      filesScanned++;
      const { errors, warnings } = scanFile(file);
      allErrors = allErrors.concat(errors);
      allWarnings = allWarnings.concat(warnings);
    }
  }

  if (allErrors.length > 0) {
    console.log('--- BLOCKING ERRORS (no legitimate use in this codebase) ---');
    for (const e of allErrors) {
      console.error(`  \x1b[31m✖ ERROR\x1b[0m [${e.pattern}] ${e.file}:${e.line}`);
      console.error(`      ${e.text}`);
    }
  }
  if (allWarnings.length > 0) {
    console.log(`\n--- WARNINGS (${allWarnings.length} -- review each; some are legitimate, e.g. array-sum accumulators) ---`);
    for (const w of allWarnings) {
      console.warn(`  \x1b[33m⚠ WARN\x1b[0m [${w.pattern}] ${w.file}:${w.line}  ${w.text}`);
    }
  }

  const passed = allErrors.length === 0;
  const status = passed ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  console.log('\n======================================================');
  console.log(`AUDIT SUMMARY: ${status}`);
  console.log(`Files Scanned    : ${filesScanned}`);
  console.log(`Blocking Errors  : ${allErrors.length}`);
  console.log(`Warnings / Notes : ${allWarnings.length}`);
  console.log('======================================================\n');

  return { passed, status, filesScanned, errors: allErrors, warnings: allWarnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = auditCode();
  // Previously this never persisted to audit_reports at all -- ARCHITECTURE.md
  // claimed `npm run audit:all` "persist[s] certified reports to audit_reports",
  // true only for the audit:main-db half. Kept out of the exported auditCode()
  // itself (a pure, synchronous, DB-independent function other future callers
  // may want to reuse without a DB side effect) and done only at this CLI
  // entry point instead.
  try {
    const { initDB, saveMainDBAuditReport } = await import('../server/db.js');
    await initDB();
    await saveMainDBAuditReport({
      targetEntity: 'STATIC_CODE_FABRICATION_AUDIT',
      recordsAudited: result.filesScanned,
      errorsCount: result.errors.length,
      warningsCount: result.warnings.length,
      status: result.status,
      reportJson: { filesScanned: result.filesScanned, errors: result.errors, warnings: result.warnings }
    });
  } catch (err) {
    console.error('[AUDITOR] Failed to save static code audit report:', err.message);
  }
  process.exit(result.passed ? 0 : 1);
}
