/**
 * paymentsService.js — recording and voiding payments.
 *
 * The two interesting operations from the original storage.js:
 *
 *   recordPayment — atomically:
 *     · INSERT a row into payments
 *     · INSERT into payment_charges for each settled charge
 *     · UPDATE the listed charges to status='paid'
 *     · OPTIONALLY INSERT a synthetic 'discount' charge with negative amount
 *       so the GSA totals stay balanced (mirrors the comment in storage.js)
 *
 *   voidPayment — atomically:
 *     · stamp voided_at / void_reason / voided_by on the payment
 *     · flip linked charges back to 'unpaid'
 *     · DELETE the synthetic discount charge created at record-time
 *
 * Both run in transactions — partial failure must not leave the student's
 * ledger in a half-applied state.
 */
'use strict';

const db = require('../db');
const studentsService = require('./studentsService');
const settingsService = require('./settingsService');
const { generateId, rowToPayment } = require('../util');

async function getAll() {
  const rows = await db.query(
    'SELECT * FROM payments ORDER BY created_at DESC'
  );
  if (!rows.length) return [];
  const links = await db.query(
    `SELECT payment_id, charge_id FROM payment_charges
       WHERE payment_id IN (${rows.map(() => '?').join(',')})`,
    rows.map(r => r.id)
  );
  const byPayment = new Map();
  for (const l of links) {
    if (!byPayment.has(l.payment_id)) byPayment.set(l.payment_id, []);
    byPayment.get(l.payment_id).push(l.charge_id);
  }
  return rows.map(r => rowToPayment(r, byPayment.get(r.id) || []));
}

async function getById(id) {
  const row = await db.queryOne(
    'SELECT * FROM payments WHERE id = ?', [id]
  );
  if (!row) return null;
  const links = await db.query(
    'SELECT charge_id FROM payment_charges WHERE payment_id = ?', [id]
  );
  return rowToPayment(row, links.map(l => l.charge_id));
}

/**
 * @param {string} studentId
 * @param {object} data    { amount, method, reference, receivedBy,
 *                           chargeIds[], discountAmount, discountLabel,
 *                           discountPercent, schoolYear }
 */
async function recordPayment(studentId, data) {
  const cashAmount     = Number(data.amount) || 0;
  const discountAmount = Number(data.discountAmount) || 0;
  const discountLabel  = (data.discountLabel || '').trim() || null;
  const discountPercent = data.discountPercent != null
    ? Number(data.discountPercent)
    : null;
  const chargeIds = Array.isArray(data.chargeIds) ? data.chargeIds : [];

  const result = await db.withTransaction(async (cx) => {
    // Verify student exists and pull its SY for fallback.
    const [stuRows] = await cx.execute(
      'SELECT id, school_year FROM students WHERE id = ?', [studentId]
    );
    if (!stuRows.length) {
      const e = new Error('Student not found'); e.status = 404; throw e;
    }
    const studentSY = stuRows[0].school_year;
    const sy = data.schoolYear || studentSY
      || await settingsService.getActiveSchoolYear(cx);

    // Sanity check the chargeIds belong to this student.
    if (chargeIds.length) {
      const [owns] = await cx.execute(
        `SELECT charge_id FROM charges
           WHERE student_id = ? AND charge_id IN (${chargeIds.map(()=>'?').join(',')})`,
        [studentId, ...chargeIds]
      );
      if (owns.length !== chargeIds.length) {
        const e = new Error('One or more charges do not belong to this student');
        e.status = 400;
        throw e;
      }
    }

    const paymentId = generateId('pay');
    const createdAt = new Date();

    await cx.execute(
      `INSERT INTO payments (
          id, student_id, amount, discount_amount, discount_label,
          discount_percent, method, reference, received_by, school_year,
          created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId, studentId, cashAmount, discountAmount, discountLabel,
        discountPercent,
        data.method,
        data.reference || null,
        data.receivedBy || 'cashier',
        sy, createdAt
      ]
    );

    if (chargeIds.length) {
      // Link payment ↔ charges.
      const linkValues = chargeIds.flatMap(cid => [paymentId, cid]);
      await cx.execute(
        `INSERT INTO payment_charges (payment_id, charge_id) VALUES
          ${chargeIds.map(() => '(?, ?)').join(',')}`,
        linkValues
      );
      // Mark charges paid.
      await cx.execute(
        `UPDATE charges SET status = 'paid', paid_at = ?
           WHERE charge_id IN (${chargeIds.map(()=>'?').join(',')})`,
        [createdAt, ...chargeIds]
      );
    }

    // Synthetic discount charge so balance math stays consistent.
    if (discountAmount > 0) {
      const discChargeId = generateId('chg');
      const refTail = paymentId.slice(-8).toUpperCase();
      const desc = discountPercent != null
        ? `Cashier-applied ${discountPercent}% discount on ₱${(cashAmount + discountAmount).toFixed(2)} of charges`
        : `Cashier-applied discount on payment ${refTail}`;
      await cx.execute(
        `INSERT INTO charges (
            charge_id, student_id, title, amount, description, source,
            payment_id, status, paid_at, school_year
         ) VALUES (?, ?, ?, ?, ?, 'discount', ?, 'paid', ?, ?)`,
        [
          discChargeId, studentId,
          discountLabel ? `Discount — ${discountLabel}` : 'Discount',
          -discountAmount, desc,
          paymentId, createdAt, sy
        ]
      );
    }

    return paymentId;
  });

  const payment = await getById(result);
  const student = await studentsService.getById(studentId);
  return { payment, student };
}

/**
 * Void a payment by stamping voided_at and reverting affected charges.
 * Idempotent: re-voiding an already-voided payment is a no-op.
 */
async function voidPayment(paymentId, options) {
  options = options || {};

  // Phase 1: do the DB work in a transaction. Returns either a "done"
  // sentinel (string paymentId) or an early result object.
  const txResult = await db.withTransaction(async (cx) => {
    const [payRows] = await cx.execute(
      'SELECT * FROM payments WHERE id = ?', [paymentId]
    );
    if (!payRows.length) return { kind: 'notFound' };
    const payment = payRows[0];
    if (payment.voided_at) return { kind: 'alreadyVoided', studentId: payment.student_id };

    await cx.execute(
      `UPDATE payments
          SET voided_at = ?, void_reason = ?, voided_by = ?
        WHERE id = ?`,
      [
        new Date(),
        (options.reason  || '').trim() || null,
        (options.voidedBy || '').trim() || null,
        paymentId
      ]
    );

    // Flip the charges this payment was settling back to 'unpaid'.
    await cx.execute(
      `UPDATE charges c
         JOIN payment_charges pc ON pc.charge_id = c.charge_id
         SET c.status = 'unpaid', c.paid_at = NULL
        WHERE pc.payment_id = ?`,
      [paymentId]
    );

    // Drop the synthetic discount charge attached to this payment, if any.
    await cx.execute(
      `DELETE FROM charges WHERE source = 'discount' AND payment_id = ?`,
      [paymentId]
    );

    return { kind: 'voided', studentId: payment.student_id };
  });

  // Phase 2: read fresh state for the response.
  if (txResult.kind === 'notFound') {
    return { payment: null, student: null };
  }
  const payment = await getById(paymentId);
  const student = await studentsService.getById(txResult.studentId);
  return { payment, student };
}

module.exports = { getAll, getById, recordPayment, voidPayment };
