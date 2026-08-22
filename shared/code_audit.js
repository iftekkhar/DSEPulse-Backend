/**
 * Static source-code fabrication audit for Backend (server/), Pipeline
 * (pipeline/src/), and the shared foundation (shared/) both depend on. Complements
 * the data-level auditors (shared/data_auditor.js for staging/main-DB records,
 * server/audit/db_auditor.js for the main DB as a whole) by catching bad patterns
 * in the CODE before they ever produce bad data -- see docs/AUDIT_RULES.md for the
 * full rationale, including the canonical null/number rule this enforces:
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

const SCAN_DIRS = ['server', 'pipeline/src', 'shared'];

// This tool's own source (and its sibling data-auditors/canonical helpers)
// legitimately contains the pattern strings being searched for -- exclude audit
// tooling and the canonical implementations themselves from the scan.
const EXCLUDE_FILES = [
  'shared/code_audit.js',
  'server/audit/db_auditor.js',
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
  // The exact shape of the fundamentals_history incident (see AUDIT_RULES.md):
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

  return { errors, warnings };
}

export function auditCode() {
  console.log('\n======================================================');
  console.log('   BACKEND + PIPELINE SOURCE CODE FABRICATION AUDIT');
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
  process.exit(result.passed ? 0 : 1);
}
