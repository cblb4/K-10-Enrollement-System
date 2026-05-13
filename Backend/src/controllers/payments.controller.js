/**
 * payments.controller.js — record and void payments.
 *
 * Both endpoints route to paymentsService, which wraps the multi-row
 * mutations in transactions. The controller's job is input validation and
 * status mapping.
 */
'use strict';

const paymentsService = require('../services/paymentsService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect } = require('../middleware/validate');

const list = asyncHandler(async (_req, res) => {
  res.json(await paymentsService.getAll());
});

const getOne = asyncHandler(async (req, res) => {
  const payment = await paymentsService.getById(req.params.id);
  if (!payment) throw new HttpError(404, 'Payment not found');
  res.json(payment);
});

/**
 * POST /api/students/:id/payments
 * Body:
 *   amount          (required, ≥ 0 — zero is fine when settling fully via discount)
 *   method          (required, e.g. 'cash', 'gcash')
 *   chargeIds[]     (required — which charges this payment settles)
 *   discountAmount  (optional, ≥ 0)
 *   discountLabel   (optional)
 *   discountPercent (optional)
 *   reference       (optional)
 *   receivedBy      (optional — defaults to 'cashier')
 */
const record = asyncHandler(async (req, res) => {
  expect(req.body, {
    amount:    'nonNegativeNumber',
    method:    { type: 'string', max: 40 },
    chargeIds: { type: 'array', min: 1 }
  });
  if (req.body.discountAmount !== undefined) {
    expect(req.body, { discountAmount: 'nonNegativeNumber' });
  }

  // Friendly client-side check: at least *something* must be paid (cash or
  // discount). The DB doesn't care; we want a clear 400 instead of an
  // ambiguous payment row.
  const cash = Number(req.body.amount) || 0;
  const disc = Number(req.body.discountAmount) || 0;
  if (cash <= 0 && disc <= 0) {
    throw new HttpError(400, 'Either amount or discountAmount must be > 0.');
  }

  // Default the cashier name from the JWT if the client didn't pass one.
  const receivedBy = req.body.receivedBy || (req.user && req.user.email) || 'cashier';

  try {
    const result = await paymentsService.recordPayment(
      req.params.id, { ...req.body, receivedBy }
    );
    res.status(201).json(result);
  } catch (err) {
    // The service throws plain Errors with an attached `status` for known
    // domain failures (student not found, charges don't belong to student).
    if (err && err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
});

/**
 * POST /api/payments/:id/void
 * Body:  { reason?: string, voidedBy?: string }
 */
const voidIt = asyncHandler(async (req, res) => {
  const voidedBy = (req.body && req.body.voidedBy)
    || (req.user && req.user.email)
    || 'cashier';
  const result = await paymentsService.voidPayment(req.params.id, {
    reason:   req.body && req.body.reason,
    voidedBy
  });
  if (!result.payment) throw new HttpError(404, 'Payment not found');
  res.json(result);
});

module.exports = { list, getOne, record, voidIt };
