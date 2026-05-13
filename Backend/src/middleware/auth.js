/**
 * auth middleware — verify JWT, confirm the user still exists, attach
 * `req.user`, optionally enforce role.
 *
 * Tokens are signed at login (see controllers/auth.controller.js) with the
 * shape:  { sub: <userId>, role, email }
 *
 * Why we re-check the DB on every request:
 *   A bare jwt.verify() only proves the token was issued by us and hasn't
 *   expired. It does NOT prove the underlying account still exists. Without
 *   a DB check, an admin deleting a user has no immediate effect — the
 *   deleted user can keep using their token until it expires (up to
 *   JWT_EXPIRES_IN, default 12h).
 *
 *   So on every authenticated request we issue one indexed primary-key
 *   SELECT against `users`. If the row is gone, we 401 and the frontend
 *   bounces to the auth page (see api.js#bounceToAuth). That same lookup
 *   also gives us the *current* role, so role changes via PATCH /users/:id
 *   take effect on the next request rather than waiting for token expiry.
 *
 *   Cost: one indexed-PK SELECT (sub-millisecond on any sane MySQL) per
 *   protected request. The system already issues several queries per
 *   request, so the relative overhead is negligible. If you ever need to
 *   scale past that, the right fix is a short-TTL in-memory cache of
 *   user-id → row, not skipping the check.
 *
 * Usage:
 *   app.get('/route', requireAuth(), handler)            // any logged-in user
 *   app.get('/route', requireAuth('cashier'), handler)   // only cashier
 *   app.get('/route', requireAuth(['admin','principal']), handler)
 */
'use strict';

const jwt = require('jsonwebtoken');
const db = require('../db');

function requireAuth(allowedRoles) {
  // Normalize allowedRoles to either null (any role) or a Set.
  const roleSet = !allowedRoles
    ? null
    : new Set(Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]);

  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let payload;
    try {
      payload = jwt.verify(m[1], process.env.JWT_SECRET);
    } catch (err) {
      // Don't leak whether it was expired vs invalid — same thing from the
      // client's POV: please log in again.
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Confirm the user still exists. This is the bit that prevents a
    // deleted account from continuing to use its already-issued JWT.
    let row;
    try {
      row = await db.queryOne(
        'SELECT id, email, role FROM users WHERE id = ?',
        [payload.sub]
      );
    } catch (err) {
      // DB error — let the central error handler take it; don't fail open.
      return next(err);
    }
    if (!row) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    // Populate req.user from the FRESH DB row, not the JWT claims. This
    // way role changes (PATCH /users/:id) take effect on the next request.
    // We keep the same minimal shape the rest of the codebase already
    // expects ({ id, role, email }) so no controllers need updating.
    req.user = { id: row.id, role: row.role, email: row.email };

    if (roleSet && !roleSet.has(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }
    next();
  };
}

module.exports = { requireAuth };
