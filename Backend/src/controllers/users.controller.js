/**
 * users.controller.js — directory of users + admin-side write endpoints.
 *
 * Read: list, getOne. The bootstrap endpoint already returns the users
 * collection; these exist for ad-hoc lookups.
 *
 * Write: create, update, remove. These are the admin-side user management
 * endpoints. They differ from sign-up (auth.controller.js) in two ways:
 *   1. They require an authenticated caller (any authed user can hit them
 *      under the current routing; tighten with role guards if you ever
 *      want "only admin can manage users" semantics).
 *   2. They don't issue a JWT — the caller already has one.
 *
 * Self-delete is blocked: an authenticated user can't delete their own
 * account through this endpoint, since the JWT they're holding would be
 * left pointing at a tombstone and the next request would 401.
 *
 * Password hashes are never sent over the wire — see rowToUser in util.js.
 */
'use strict';

const simple = require('../services/simpleService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect, ROLES } = require('../middleware/validate');

const list = asyncHandler(async (_req, res) => {
  res.json(await simple.users.getAll());
});

const getOne = asyncHandler(async (req, res) => {
  const u = await simple.users.getById(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  res.json(u);
});

const create = asyncHandler(async (req, res) => {
  expect(req.body, {
    fullName: { type: 'string', max: 200 },
    email:    'email',
    password: { type: 'string', min: 6, max: 200 },
    role:     { type: 'enum', values: ROLES }
  });

  try {
    const user = await simple.users.create(req.body);
    res.status(201).json(user);
  } catch (err) {
    // The service throws plain Errors with `status` for known domain
    // failures (duplicate email).
    if (err && err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  // PATCH-style — every field optional, but we typecheck anything supplied.
  const spec = {};
  if (req.body.fullName !== undefined) spec.fullName = { type: 'string', max: 200 };
  if (req.body.email    !== undefined) spec.email    = 'email';
  if (req.body.role     !== undefined) spec.role     = { type: 'enum', values: ROLES };
  if (req.body.password !== undefined) spec.password = { type: 'string', min: 6, max: 200 };
  if (Object.keys(spec).length) expect(req.body, spec);

  try {
    const user = await simple.users.update(req.params.id, req.body);
    if (!user) throw new HttpError(404, 'User not found');
    res.json(user);
  } catch (err) {
    if (err && err.status && !(err instanceof HttpError)) {
      throw new HttpError(err.status, err.message);
    }
    throw err;
  }
});

const remove = asyncHandler(async (req, res) => {
  // Block self-delete: the caller's JWT would still be valid until expiry
  // but every subsequent /auth/me would 401 ("User no longer exists"),
  // which is a confusing UX. Force them to use a different account.
  if (req.user && req.user.id === req.params.id) {
    throw new HttpError(400, "You can't delete the account you're signed in as.");
  }

  const ok = await simple.users.remove(req.params.id);
  if (!ok) throw new HttpError(404, 'User not found');
  res.status(204).end();
});

module.exports = { list, getOne, create, update, remove };
