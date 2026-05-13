/**
 * migrate.js — Apply SQL migrations from /migrations.
 *
 * Naming convention: NNN_description.sql, applied in numeric order.
 * Each filename is recorded once it succeeds, so re-running this script
 * is idempotent. Migrations are NOT run inside a single transaction
 * because some DDL statements implicitly commit in MySQL — instead, we
 * apply files one at a time and bail on the first failure.
 *
 * Usage:   node src/migrate.js
 *          npm run migrate
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main() {
  const dbName = process.env.DB_NAME || 'hlc_enrollment';

  // Connect WITHOUT a database first so we can CREATE DATABASE if missing.
  const root = await mysql.createConnection({
    host:               process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT,10)  || 3306,
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  try {
    // The DB name is interpolated (NOT a parameter) because MySQL doesn't
    // support placeholders for identifiers. We escape it strictly using
    // mysql2's escapeId, which protects against injection from the env var.
    const escapedDb = mysql.escapeId(dbName);
    await root.query(
      `CREATE DATABASE IF NOT EXISTS ${escapedDb}
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await root.query(`USE ${escapedDb}`);

    // Bookkeeping table for which migrations have been applied.
    await root.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [appliedRows] = await root.query(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(appliedRows.map(r => r.filename));

    if (!fs.existsSync(MIGRATIONS_DIR)) {
      console.log('No migrations directory; nothing to do.');
      return;
    }
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let runCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`✓ ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→ applying ${file} …`);
      await root.query(sql);
      await root.query(
        'INSERT INTO schema_migrations (filename) VALUES (?)',
        [file]
      );
      console.log(`  ✓ applied ${file}`);
      runCount++;
    }

    if (runCount === 0) {
      console.log('Database is up to date.');
    } else {
      console.log(`Done. Applied ${runCount} migration(s).`);
    }
  } finally {
    await root.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
