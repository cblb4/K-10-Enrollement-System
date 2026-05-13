/**
 * activityLog.controller.js — list and append.
 *
 * Append-only: there's no update/remove endpoint. The principal's audit
 * trail UI calls list with a query-string `limit` (default 1000, capped at
 * 5000 in the service).
 */
'use strict';

const simple = require('../services/simpleService');
const { asyncHandler } = require('../middleware/errorHandler');
const { expect } = require('../middleware/validate');

const list = asyncHandler(async (req, res) => {
  const rows = await simple.activity.getAll(req.query.limit);
  res.json(rows);
});

const append = asyncHandler(async (req, res) => {
  expect(req.body, {
    action: { type: 'string', max: 100 }
    // role and details are optional
  });
  const row = await simple.activity.append({
    role:    req.body.role || (req.user && req.user.role) || null,
    action:  req.body.action,
    details: req.body.details || ''
  });
  res.status(201).json(row);
});

module.exports = { list, append };
