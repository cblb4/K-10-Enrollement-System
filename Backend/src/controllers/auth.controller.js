/**
 * auth.controller.js — sign-up, sign-in, "who am I".
 *
 * Replaces the localStorage + SHA-256 demo from the original frontend with:
 *   - bcrypt password hashing (cost 12)
 *   - JWT session tokens (signed with JWT_SECRET, exp from JWT_EXPIRES_IN)
 *   - generic error messages on bad credentials (no enumeration)
 *
 * The frontend keeps the JWT in localStorage under 'hlc_token' and sends it
 * as `Authorization: Bearer <jwt>` on every protected call.
 */
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../db');
const { generateId, rowToUser } = require('../util');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect, ROLES } = require('../middleware/validate');

const BCRYPT_COST = 12;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

const signup = asyncHandler(async (req, res) => {
  expect(req.body, {
    fullName: { type: 'string', max: 200 },
    email:    'email',
    password: { type: 'string', min: 6, max: 200 },
    role:     { type: 'enum', values: ROLES }
  });

  const fullName = req.body.fullName.trim();
  const email    = req.body.email.trim().toLowerCase();
  const password = req.body.password;
  const role     = req.body.role;

  // Pre-check for friendlier 409 (also enforced by UNIQUE index on email).
  const existing = await db.queryOne(
    'SELECT id FROM users WHERE email = ?', [email]
  );
  if (existing) throw new HttpError(409, 'An account with that email already exists.');

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const id = generateId('usr');

  await db.query(
    `INSERT INTO users (id, full_name, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
    [id, fullName, email, passwordHash, role]
  );

  const row = await db.queryOne(
    'SELECT id, full_name, email, role, created_at FROM users WHERE id = ?', [id]
  );
  const user = rowToUser(row);
  const token = signToken(user);
  res.status(201).json({ user, token });
});

const login = asyncHandler(async (req, res) => {
  expect(req.body, {
    email:    'email',
    password: { type: 'string', min: 1 }
  });

  const email    = req.body.email.trim().toLowerCase();
  const password = req.body.password;

  // Look up user including the hash we need to compare against. We DON'T
  // expose this row directly — only the sanitized rowToUser version is sent.
  const row = await db.queryOne(
    'SELECT id, full_name, email, password_hash, role, created_at FROM users WHERE email = ?',
    [email]
  );

  // Generic error message for both "no such email" and "wrong password" so
  // an attacker can't enumerate which emails are registered.
  const GENERIC_BAD = 'Incorrect email or password.';

  if (!row) throw new HttpError(401, GENERIC_BAD);
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw new HttpError(401, GENERIC_BAD);

  const user  = rowToUser(row);
  const token = signToken(user);
  res.json({ user, token });
});

/**
 * Returns the current authenticated user (from the JWT-decoded req.user).
 * Re-fetches the row from the DB so role/email changes propagate without
 * the client having to log out and back in.
 */
const me = asyncHandler(async (req, res) => {
  const row = await db.queryOne(
    'SELECT id, full_name, email, role, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!row) throw new HttpError(401, 'User no longer exists.');
  res.json({ user: rowToUser(row) });
});

module.exports = { signup, login, me };
