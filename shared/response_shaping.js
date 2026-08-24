/**
 * Strips internal-only fields from an object (or array of objects) before
 * it reaches a public API response. `source`/`tier` are load-bearing for
 * this project's own audit/provenance tracking (see shared/source_tiers.js,
 * server/audit/db_auditor.js) but have no business being visible to an
 * end user or a scraper of this API -- they reveal which upstream source
 * (dsebd.org, lankabd.com, the promotion pipeline) a given value came from,
 * which is exactly the kind of implementation detail the premium-tier plan
 * calls out as something the frontend should never expose. This is
 * unconditional (applies regardless of entitlement) -- it's not a paywall
 * concern, it's "this was never meant to be public in the first place."
 */
const INTERNAL_ONLY_FIELDS = ['source', 'tier'];

export function stripInternalFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripInternalFields);
  }
  if (value && typeof value === 'object') {
    const clean = { ...value };
    for (const field of INTERNAL_ONLY_FIELDS) delete clean[field];
    return clean;
  }
  return value;
}
