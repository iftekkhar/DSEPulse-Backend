/**
 * Canonical null/number handling for this project. One rule, one implementation,
 * used everywhere instead of a hand-rolled ternary re-derived (and re-gotten-wrong)
 * at each call site -- see docs/AUDIT_RULES.md for the incidents this caused.
 *
 * THE RULE:
 *   1. Never use `||` for a numeric fallback -- it treats a real `0` the same as
 *      missing data. Always `??` (or, more explicitly, one of the helpers below).
 *   2. The fallback for a genuinely-missing value is always `null` -- never `0`,
 *      never another field's value, never a hardcoded constant.
 *   3. `?? 0` is permitted in exactly one place: a loop-local running-total
 *      variable being summed (e.g. `totalVal += sumTerm(r.value)`) -- never for a
 *      value that gets returned, stored, or displayed as "the" value of a field.
 *      Use `sumTerm()` below for that case so it's a named, intentional exception
 *      rather than a bare `?? 0`/`|| 0` indistinguishable from a bug.
 *   4. Never default one semantically-different field to another (`ycp ?? close`,
 *      `high ?? close`) -- that's fabrication, not a null-fallback, regardless of
 *      operator. Two independently-real values may be combined via exact
 *      arithmetic (`deriveOrNull` below); a missing value may not be borrowed
 *      from an unrelated field.
 */

/**
 * Parses `value` as a number, returning `null` if it's missing, unparseable, or
 * NaN. This is the one place "is this value usable as a number" gets decided --
 * every other file should call this instead of `x !== null && x !== undefined ?
 * Number(x) : null` (easy to typo into `x !== undefined` alone, which misses null
 * and lets `Number(null)` -- silently 0 -- through; see the fundamentals_history
 * incident in AUDIT_RULES.md).
 */
export function numOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (cleaned === '' || cleaned === '-' || cleaned === 'N/A' || cleaned === 'n/a') return null;
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  }
  const n = Number(value);
  return isNaN(n) ? null : n;
}

/**
 * Same as numOrNull, but rejects zero and negative values too (returns null
 * instead) -- for fields that are structurally impossible at exactly 0 for a real
 * listed company (P/E, paid-up capital, NAVPS, a traded close price). Use this
 * instead of numOrNull when 0 itself is not a legitimate value, not just when the
 * value is missing.
 */
export function positiveNumOrNull(value) {
  const n = numOrNull(value);
  return (n !== null && n > 0) ? n : null;
}

/**
 * Combines two values via `fn` only when BOTH are real (non-null) numbers --
 * otherwise returns null. This is the only sanctioned way to fabricate-free-ly
 * fill in a value from other values: exact arithmetic over two things that are
 * themselves already known to be real, e.g.
 *   deriveOrNull(close, ycp, (c, y) => c - y)   // change
 *   deriveOrNull(eps, navps, (e, n) => (e / n) * 100)   // ROE
 * Never use this to borrow one field's value AS another (that's not derivation,
 * that's fabrication) -- only to compute a genuinely different quantity from two
 * real inputs.
 */
export function deriveOrNull(a, b, fn) {
  const numA = numOrNull(a);
  const numB = numOrNull(b);
  if (numA === null || numB === null) return null;
  const result = fn(numA, numB);
  return typeof result === 'number' && !isNaN(result) ? result : null;
}

/**
 * The ONE sanctioned use of "treat missing as 0": a loop-local running-total
 * accumulator, where an unknown per-record value should contribute nothing to
 * the aggregate rather than abort the sum. Never use this for a field that gets
 * stored/returned/displayed as its own value -- only as the addend inside
 * `total += sumTerm(r.value)`.
 */
export function sumTerm(value) {
  const n = numOrNull(value);
  return n === null ? 0 : n;
}

/**
 * Rounds a possibly-null number to `digits` decimal places, staying null if the
 * input is null. Saves the `x !== null ? Number(x.toFixed(n)) : null` ternary
 * that otherwise gets rewritten slightly differently at every call site.
 */
export function roundOrNull(value, digits = 2) {
  const n = numOrNull(value);
  return n === null ? null : Number(n.toFixed(digits));
}
