/**
 * studentsService.js — student CRUD plus charge-related helpers.
 *
 * The "charges" model in the original frontend is an embedded array on the
 * student document. In MySQL we store charges in their own table (see
 * schema), but we hydrate the same nested shape on read so the frontend
 * doesn't need to learn a new format.
 *
 * Helpers mirrored from the original storage.js:
 *   - addCharge
 *   - applySchoolWideFees   (school-wide + grade-targeted auto-apply)
 *   - applyMiscFee          (one optional fee per call)
 *   - assignSubjectsToStudent
 *
 * All multi-row writes run inside a transaction so partial failures don't
 * leave the books in an inconsistent state.
 */
'use strict';

const db = require('../db');
const { generateId, rowToStudent, rowToCharge, rowToMiscFee } = require('../util');
const settingsService = require('./settingsService');

// ─── Read helpers ────────────────────────────────────────────────────────

async function getById(id) {
  const row = await db.queryOne('SELECT * FROM students WHERE id = ?', [id]);
  if (!row) return null;
  const charges = await db.query(
    `SELECT * FROM charges
       WHERE student_id = ? AND is_archived = 0
       ORDER BY created_at ASC`,
    [id]
  );
  const archived = await db.query(
    `SELECT * FROM charges
       WHERE student_id = ? AND is_archived = 1
       ORDER BY archived_at ASC`,
    [id]
  );
  return rowToStudent(row, charges, archived);
}

/**
 * Get all students with their charges in 3 queries instead of N+1:
 *   1) fetch students
 *   2) fetch all charges keyed by student_id
 *   3) group charges → student
 */
async function getAll() {
  const studentRows = await db.query(
    'SELECT * FROM students ORDER BY created_at DESC'
  );
  if (!studentRows.length) return [];

  const allCharges = await db.query(
    'SELECT * FROM charges WHERE student_id IN (' +
      studentRows.map(() => '?').join(',') + ')',
    studentRows.map(s => s.id)
  );

  const activeByStudent = new Map();
  const archivedByStudent = new Map();
  for (const c of allCharges) {
    const bag = c.is_archived ? archivedByStudent : activeByStudent;
    if (!bag.has(c.student_id)) bag.set(c.student_id, []);
    bag.get(c.student_id).push(c);
  }
  return studentRows.map(s =>
    rowToStudent(s, activeByStudent.get(s.id) || [], archivedByStudent.get(s.id) || [])
  );
}

// ─── Create / Update / Delete ────────────────────────────────────────────

async function create(input) {
  const id = input.id || generateId('stu');
  const sy = input.schoolYear || await settingsService.getActiveSchoolYear();

  await db.query(
    `INSERT INTO students (
        id, first_name, last_name, middle_name, birth_date, gender,
        grade_level, guardian_name, contact, address, notes,
        status, payment_status, payment_mode, section_id, school_year,
        discount_label, discount_amount, discount_percent
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.firstName, input.lastName, input.middleName || null,
      input.birthDate || null, input.gender || null,
      input.gradeLevel,
      input.guardianName, input.contact, input.address,
      input.notes || null,
      input.status || 'pending',
      input.paymentStatus || 'unpaid',
      input.paymentMode || 'full',
      input.section || null,
      sy,
      input.discount && input.discount.label   ? input.discount.label   : null,
      input.discount && input.discount.amount  != null ? input.discount.amount  : null,
      input.discount && input.discount.percent != null ? input.discount.percent : null
    ]
  );
  return getById(id);
}

/**
 * Patch a subset of fields on a student. Only known columns are written, so
 * a malicious caller can't sneak in unexpected SET clauses.
 *
 * NOTE: does NOT modify charges. Charge changes go through dedicated
 * endpoints (addCharge, recordPayment, etc.) so accounting stays auditable.
 */
const PATCHABLE_FIELDS = {
  firstName:     'first_name',
  lastName:      'last_name',
  middleName:    'middle_name',
  birthDate:     'birth_date',
  gender:        'gender',
  gradeLevel:    'grade_level',
  guardianName:  'guardian_name',
  contact:       'contact',
  address:       'address',
  notes:         'notes',
  status:        'status',
  paymentStatus: 'payment_status',
  paymentMode:   'payment_mode',
  section:       'section_id',
  schoolYear:    'school_year'
};

async function update(id, patch) {
  const existing = await db.queryOne('SELECT id FROM students WHERE id = ?', [id]);
  if (!existing) return null;

  const setFragments = [];
  const values = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (PATCHABLE_FIELDS[k]) {
      setFragments.push(`${PATCHABLE_FIELDS[k]} = ?`);
      values.push(v === '' ? null : v);
    } else if (k === 'discount') {
      setFragments.push('discount_label = ?');   values.push(v && v.label   ? v.label : null);
      setFragments.push('discount_amount = ?');  values.push(v && v.amount  != null ? v.amount  : null);
      setFragments.push('discount_percent = ?'); values.push(v && v.percent != null ? v.percent : null);
    }
  }
  if (!setFragments.length) {
    return getById(id);
  }
  values.push(id);
  await db.query(
    `UPDATE students SET ${setFragments.join(', ')} WHERE id = ?`,
    values
  );
  return getById(id);
}

async function remove(id) {
  // FK ON DELETE CASCADE handles charges/payments/payment_charges.
  const [result] = await db.pool.execute(
    'DELETE FROM students WHERE id = ?',
    [id]
  );
  return result.affectedRows > 0;
}

// ─── Charge helpers ──────────────────────────────────────────────────────

/**
 * Insert a single charge for a student, inheriting the school year from
 * (chargeData.schoolYear → student.schoolYear → active SY).
 *
 * Returns the new charge row (camelCase) and the refreshed student.
 */
async function addCharge(studentId, chargeData) {
  const student = await db.queryOne(
    'SELECT id, school_year FROM students WHERE id = ?', [studentId]
  );
  if (!student) return null;

  const sy = chargeData.schoolYear
    || student.school_year
    || await settingsService.getActiveSchoolYear();

  const chargeId = chargeData.chargeId || generateId('chg');

  await db.query(
    `INSERT INTO charges (
        charge_id, student_id, title, amount, description, source,
        subject_id, misc_fee_id, fee_scope, category, school_year, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid')`,
    [
      chargeId, studentId,
      chargeData.title,
      Number(chargeData.amount) || 0,
      chargeData.description || null,
      chargeData.source || 'manual',
      chargeData.subjectId || null,
      chargeData.miscFeeId || null,
      chargeData.feeScope  || null,
      chargeData.category  || null,
      sy
    ]
  );
  const row = await db.queryOne(
    'SELECT * FROM charges WHERE charge_id = ?', [chargeId]
  );
  return { charge: rowToCharge(row), student: await getById(studentId) };
}

/**
 * Apply every misc fee with auto_apply=1 that targets this student's
 * grade-level + school-year. Skips fees already applied (by misc_fee_id).
 *
 * Mirrors storage.js#applySchoolWideFees, including the school-year guard
 * and the 'school' vs 'grades' scope dispatch.
 */
async function applySchoolWideFees(studentId) {
  return db.withTransaction(async (cx) => {
    const [studentRows] = await cx.execute(
      'SELECT * FROM students WHERE id = ?', [studentId]
    );
    if (!studentRows.length) return { applied: [], student: null };
    const student = studentRows[0];

    const sy = student.school_year
      || await settingsService.getActiveSchoolYear(cx);

    // Already-applied: any non-archived charge with source='misc-fee'
    // referencing one of the fees.
    const [appliedRows] = await cx.execute(
      `SELECT misc_fee_id FROM charges
         WHERE student_id = ? AND source = 'misc-fee'
           AND misc_fee_id IS NOT NULL`,
      [studentId]
    );
    const alreadyApplied = new Set(appliedRows.map(r => r.misc_fee_id));

    // Candidate fees: auto-apply, same school-year, scope school OR
    //                 (scope grades AND this student's grade is targeted).
    const [feeRows] = await cx.execute(
      `SELECT f.* FROM misc_fees f
         WHERE f.auto_apply = 1
           AND f.school_year = ?
           AND (
             f.scope = 'school'
             OR (
               f.scope = 'grades'
               AND EXISTS (
                 SELECT 1 FROM misc_fee_grades g
                   WHERE g.misc_fee_id = f.id
                     AND g.grade_level = ?
               )
             )
           )`,
      [sy, student.grade_level]
    );

    const applied = [];
    for (const fee of feeRows) {
      if (alreadyApplied.has(fee.id)) continue;
      const chargeId = generateId('chg');
      await cx.execute(
        `INSERT INTO charges (
            charge_id, student_id, title, amount, description, source,
            misc_fee_id, fee_scope, category, school_year, status
         ) VALUES (?, ?, ?, ?, ?, 'misc-fee', ?, ?, ?, ?, 'unpaid')`,
        [
          chargeId, studentId,
          fee.name, fee.amount, fee.description || null,
          fee.id,
          fee.scope,
          fee.category || (fee.scope === 'grades' ? 'Grade-level' : 'School-wide'),
          fee.school_year
        ]
      );
      applied.push(rowToMiscFee(fee, []));
    }

    return { applied };
  }).then(async (r) => ({
    ...r,
    student: await getById(studentId)
  }));
}

/**
 * Apply ONE optional misc fee to a student. Skips if already applied.
 * Used by the cashier "apply optional fee" UI.
 */
async function applyMiscFee(studentId, miscFeeId) {
  const student = await db.queryOne(
    'SELECT id, grade_level, school_year FROM students WHERE id = ?',
    [studentId]
  );
  if (!student) return null;
  const fee = await db.queryOne(
    'SELECT * FROM misc_fees WHERE id = ?', [miscFeeId]
  );
  if (!fee) return null;
  // Already applied?
  const dup = await db.queryOne(
    `SELECT charge_id FROM charges
       WHERE student_id = ? AND source = 'misc-fee' AND misc_fee_id = ?
         AND is_archived = 0
       LIMIT 1`,
    [studentId, miscFeeId]
  );
  if (dup) return { fee: null, student: await getById(studentId), alreadyApplied: true };

  await db.query(
    `INSERT INTO charges (
        charge_id, student_id, title, amount, description, source,
        misc_fee_id, fee_scope, category, school_year, status
     ) VALUES (?, ?, ?, ?, ?, 'misc-fee', ?, ?, ?, ?, 'unpaid')`,
    [
      generateId('chg'), studentId,
      fee.name, fee.amount, fee.description || null,
      fee.id, fee.scope, fee.category || 'Optional',
      fee.school_year || student.school_year
    ]
  );
  return { fee: rowToMiscFee(fee, []), student: await getById(studentId), alreadyApplied: false };
}

/**
 * Assign subjects to a student. Each one becomes a zero-amount charge with
 * source='subject'. Subjects already assigned are skipped (returned as
 * `skipped` in the response).
 */
async function assignSubjectsToStudent(studentId, subjectIds) {
  if (!Array.isArray(subjectIds) || !subjectIds.length) {
    return { assigned: [], skipped: [], student: await getById(studentId) };
  }
  return db.withTransaction(async (cx) => {
    const [studentRows] = await cx.execute(
      'SELECT * FROM students WHERE id = ?', [studentId]
    );
    if (!studentRows.length) {
      return { assigned: [], skipped: [], student: null };
    }
    const student = studentRows[0];

    const [existing] = await cx.execute(
      `SELECT subject_id FROM charges
         WHERE student_id = ? AND source = 'subject'
           AND subject_id IS NOT NULL`,
      [studentId]
    );
    const alreadyAssigned = new Set(existing.map(r => r.subject_id));

    const assigned = [];
    const skipped = [];

    for (const sid of subjectIds) {
      if (alreadyAssigned.has(sid)) { skipped.push(sid); continue; }
      const [subjRows] = await cx.execute(
        'SELECT * FROM subjects WHERE id = ?', [sid]
      );
      if (!subjRows.length) continue;
      const sub = subjRows[0];
      await cx.execute(
        `INSERT INTO charges (
            charge_id, student_id, title, amount, description, source,
            subject_id, school_year, status
         ) VALUES (?, ?, ?, 0, ?, 'subject', ?, ?, 'unpaid')`,
        [
          generateId('chg'), studentId,
          sub.name,
          sub.description || ('Subject fee for ' + sub.name),
          sub.id,
          student.school_year
        ]
      );
      assigned.push({
        id: sub.id, name: sub.name, gradeLevel: sub.grade_level,
        fee: 0, description: sub.description || ''
      });
    }

    return { assigned, skipped };
  }).then(async (r) => ({
    ...r,
    student: await getById(studentId)
  }));
}

/**
 * Lightweight status fetch — used by the controller to detect an
 * upward status transition (pending → approved) without pulling the
 * whole student row + its charges.
 */
async function getStatus(id) {
  const row = await db.queryOne('SELECT status FROM students WHERE id = ?', [id]);
  return row ? row.status : null;
}

module.exports = {
  getAll,
  getById,
  getStatus,
  create,
  update,
  remove,
  addCharge,
  applySchoolWideFees,
  applyMiscFee,
  assignSubjectsToStudent
};
