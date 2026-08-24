/**
 * Runtime-tunable app configuration, admin-editable with no deploy needed --
 * same override pattern as shared/scraper_registry.js: this file defines the
 * canonical default for each setting, an in-memory Map holds any admin
 * override for the current process, and server/admin_routes.js writes the
 * durable copy to the `app_settings` DB table (survives a restart) while
 * also calling setSettingOverride in the same process so the change is live
 * immediately, no restart required. server/index.js loads existing DB rows
 * into this map once at boot (mirrors the scraper_settings boot-load).
 *
 * Deliberately does NOT include PLANS or FREE_WINDOW_DAYS from
 * shared/plans.js -- see that file's own docstring. Pricing and the free
 * window stay a reviewed code change; this module is for the settings that
 * are meant to be marketing/ops levers (2026-08-24 decision, after the same
 * question was raised for pricing and answered "keep pricing code-only").
 */

export const DEFAULT_APP_SETTINGS = {
  // Free/anonymous users can compare up to this many stocks side by side
  // before hitting the "upgrade to compare more" gate (see App.jsx's
  // handleToggleCompare). Was a hardcoded FREE_COMPARE_LIMIT = 2 constant.
  freeCompareLimit: 2,

  // Site-wide banner, shown to every visitor when active (e.g. "Scheduled
  // maintenance tonight 11pm-1am BST"). level drives the banner's color.
  announcement: {
    active: false,
    message: '',
    level: 'info', // 'info' | 'warning' | 'critical'
  },
};

const SETTING_KEYS = Object.keys(DEFAULT_APP_SETTINGS);

export function isValidSettingKey(key) {
  return SETTING_KEYS.includes(key);
}

const runtimeOverrides = new Map();

export function setSettingOverride(key, value) {
  runtimeOverrides.set(key, value);
}

export function clearSettingOverride(key) {
  runtimeOverrides.delete(key);
}

/** Returns the effective value for a setting: runtime override if one exists, else the file default. */
export function getSetting(key) {
  if (runtimeOverrides.has(key)) return runtimeOverrides.get(key);
  return DEFAULT_APP_SETTINGS[key];
}

/** Returns { [key]: { value, isOverridden } } for every known setting -- what the admin panel needs to show current state vs. default. */
export function getAllSettingsWithStatus() {
  const out = {};
  for (const key of SETTING_KEYS) {
    out[key] = { value: getSetting(key), isOverridden: runtimeOverrides.has(key) };
  }
  return out;
}

/** Returns { [key]: value } for every known setting -- what the public /api/app-config route serves to the frontend. */
export function getAllSettings() {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = getSetting(key);
  return out;
}
