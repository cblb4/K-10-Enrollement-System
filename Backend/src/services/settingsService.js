/**
 * settingsService.js — key/value config store (app_settings table).
 *
 * Values are JSON-encoded so the same store works for strings, arrays,
 * and small objects. The only really-used key in this app is
 * `activeSchoolYear` (string), but the cashier UI also writes a
 * `knownSchoolYears` (string[]) when adding a placeholder year.
 */
'use strict';

const db = require('../db');

const DEFAULT_SCHOOL_YEAR = '2025-2026';
const KEY_ACTIVE_SY = 'activeSchoolYear';

async function get(key, defaultValue) {
  const row = await db.queryOne(
    'SELECT setting_value FROM app_settings WHERE setting_key = ?',
    [key]
  );
  if (!row) return defaultValue !== undefined ? defaultValue : null;
  try {
    return row.setting_value === null ? null : JSON.parse(row.setting_value);
  } catch (e) {
    // Stored bad JSON somehow — fall back to raw string so we don't crash.
    return row.setting_value;
  }
}

async function set(key, value) {
  const json = JSON.stringify(value);
  await db.query(
    `INSERT INTO app_settings (setting_key, setting_value)
       VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, json]
  );
  return value;
}

async function getAll() {
  const rows = await db.query('SELECT setting_key, setting_value FROM app_settings');
  const out = {};
  for (const r of rows) {
    try { out[r.setting_key] = r.setting_value === null ? null : JSON.parse(r.setting_value); }
    catch (e) { out[r.setting_key] = r.setting_value; }
  }
  return out;
}

/**
 * @param {object} [cx] — optional transaction connection. If passed, the
 *                        read happens inside the same transaction.
 */
async function getActiveSchoolYear(cx) {
  if (cx) {
    const [rows] = await cx.execute(
      'SELECT setting_value FROM app_settings WHERE setting_key = ?',
      [KEY_ACTIVE_SY]
    );
    if (!rows.length) return DEFAULT_SCHOOL_YEAR;
    try { return JSON.parse(rows[0].setting_value); }
    catch (e) { return rows[0].setting_value || DEFAULT_SCHOOL_YEAR; }
  }
  return get(KEY_ACTIVE_SY, DEFAULT_SCHOOL_YEAR);
}

async function setActiveSchoolYear(sy) {
  if (!sy || typeof sy !== 'string') return null;
  await set(KEY_ACTIVE_SY, sy);
  return sy;
}

module.exports = {
  get, set, getAll,
  getActiveSchoolYear, setActiveSchoolYear,
  DEFAULT_SCHOOL_YEAR
};
