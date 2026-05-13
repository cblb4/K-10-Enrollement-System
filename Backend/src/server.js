/**
 * server.js — Express entrypoint.
 *
 * Boot sequence:
 *   1. Load .env
 *   2. Sanity-check JWT_SECRET (fail fast — refusing to start unauth'd is
 *      better than running with a guessable secret)
 *   3. Ping the database (also fail fast on connection problems)
 *   4. Wire up CORS, JSON body parser, the API router, error handler
 *   5. Listen
 *
 * Run with:
 *     node src/server.js          (or)   npm start
 *     node --watch src/server.js  (or)   npm run dev
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const db          = require('./db');
const router      = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');

const PORT = parseInt(process.env.PORT, 10) || 4000;

function buildCorsOptions() {
  // CORS_ORIGIN can be:
  //   - "*"               → allow any origin (dev only)
  //   - "https://x.com"   → single origin
  //   - "https://a, https://b" → comma-separated allowlist
  const raw = (process.env.CORS_ORIGIN || '*').trim();
  if (raw === '*') return { origin: true, credentials: true };
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  return {
    origin(origin, cb) {
      // Same-origin / curl / server-to-server have no Origin header — allow.
      if (!origin) return cb(null, true);
      cb(null, allowed.includes(origin));
    },
    credentials: true
  };
}

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'replace-me-with-a-long-random-string') {
    console.error('[fatal] JWT_SECRET is not set. Edit .env and provide a long random string.');
    console.error('         Tip: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
  }

  // Verify the DB is reachable before we start accepting requests.
  try {
    await db.ping();
  } catch (err) {
    console.error('[fatal] Cannot connect to MySQL:', err.message);
    console.error('         Did you run "npm run migrate" first? Is MySQL running?');
    console.error('         Check DB_* values in .env.');
    process.exit(1);
  }

  const app = express();

  app.use(cors(buildCorsOptions()));
  // Generous JSON body limit because faculty photos travel as base64
  // data-URIs (MEDIUMTEXT in the schema). 5MB is comfortably above any
  // reasonable user avatar.
  app.use(express.json({ limit: '5mb' }));

  // Mount API.
  app.use('/api', router);

  // Tiny health probe — useful for "is the server alive?" checks without
  // having to authenticate.
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Error handler is mounted LAST so any thrown HttpError or rejected
  // promise routes through here.
  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log(`Heartworks backend listening on http://localhost:${PORT}`);
    console.log(`API base: http://localhost:${PORT}/api`);
  });
}

main().catch(err => {
  console.error('[fatal] Boot failed:', err);
  process.exit(1);
});
