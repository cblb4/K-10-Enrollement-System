/**
 * db.js — MySQL connection pool + small query helpers.
 *
 * All DB access in this app goes through this module. Pool sizing keeps
 * things light for an internal-school-system workload; bump
 * connectionLimit if you start running heavier reporting jobs.
 *
 * Every helper uses parameterized queries (placeholders + values array),
 * so user input is never interpolated into SQL — protects against SQLi.
 */
'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT,10)  || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'hlc_enrollment',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Prevent silent loss-of-precision on DECIMAL columns (currency).
  decimalNumbers: true,
  // Treat DATE columns as plain 'YYYY-MM-DD' strings; otherwise mysql2
  // returns Date objects with timezone surprises that don't round-trip.
  dateStrings: ['DATE']
});

// ─── Query helpers ───────────────────────────────────────────────────────
// `pool.execute` uses prepared statements — placeholders are typed and
// quoted by the driver, so user input cannot break out of its slot.

/** Run a query and return the rows array. */
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params || []);
  return rows;
}

/** Run a query and return the first row (or null if none). */
async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Run a function inside a transaction. The function receives a connection
 * and must use it (not the pool) for all queries within the transaction.
 *
 *   await withTransaction(async (cx) => {
 *     await cx.execute('INSERT ...', [...]);
 *     await cx.execute('UPDATE ...', [...]);
 *   });
 *
 * On any throw, the transaction is rolled back and the error rethrown.
 */
async function withTransaction(fn) {
  const cx = await pool.getConnection();
  try {
    await cx.beginTransaction();
    const result = await fn(cx);
    await cx.commit();
    return result;
  } catch (err) {
    try { await cx.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    cx.release();
  }
}

/** Sanity-check the connection at startup. Throws on failure. */
async function ping() {
  const cx = await pool.getConnection();
  try {
    await cx.ping();
  } finally {
    cx.release();
  }
}

module.exports = { pool, query, queryOne, withTransaction, ping };
