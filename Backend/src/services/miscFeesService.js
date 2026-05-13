/**
 * miscFeesService.js — catalog of school-wide / grade-targeted / optional fees.
 *
 * Each fee row joins to misc_fee_grades for its targeted grade levels (only
 * when scope='grades'). The mapper hydrates that array on read so the
 * frontend gets the same `gradeLevels: [...]` shape it had with localStorage.
 *
 * editMiscFee mirrors the original semantics:
 *   - existing charges already on student accounts are NOT modified
 *     (snapshot pricing — change is forward-looking)
 *   - if the fee is auto-apply, new matching students get billed
 */
'use strict';

const db = require('../db');
const { generateId, rowToMiscFee } = require('../util');
const studentsService = require('./studentsService');

async function getAll() {
  const rows = await db.query(
    'SELECT * FROM misc_fees ORDER BY created_at DESC'
  );
  if (!rows.length) return [];
  const grades = await db.query(
    `SELECT misc_fee_id, grade_level FROM misc_fee_grades
       WHERE misc_fee_id IN (${rows.map(() => '?').join(',')})`,
    rows.map(r => r.id)
  );
  const byFee = new Map();
  for (const g of grades) {
    if (!byFee.has(g.misc_fee_id)) byFee.set(g.misc_fee_id, []);
    byFee.get(g.misc_fee_id).push(g.grade_level);
  }
  return rows.map(r => rowToMiscFee(r, byFee.get(r.id) || []));
}

async function getById(id) {
  const row = await db.queryOne(
    'SELECT * FROM misc_fees WHERE id = ?', [id]
  );
  if (!row) return null;
  const grades = await db.query(
    'SELECT grade_level FROM misc_fee_grades WHERE misc_fee_id = ?',
    [id]
  );
  return rowToMiscFee(row, grades.map(g => g.grade_level));
}

async function create(input) {
  const id = input.id || generateId('mf');
  const scope = input.scope;
  const autoApply = (scope === 'school' || scope === 'grades') ? 1 : 0;
  const gradeLevels = scope === 'grades' && Array.isArray(input.gradeLevels)
    ? input.gradeLevels
    : [];

  await db.withTransaction(async (cx) => {
    await cx.execute(
      `INSERT INTO misc_fees (
          id, name, amount, category, scope, auto_apply, description, school_year
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        Number(input.amount) || 0,
        input.category || null,
        scope,
        autoApply,
        input.description || null,
        input.schoolYear
      ]
    );
    if (gradeLevels.length) {
      const values = gradeLevels.flatMap(g => [id, g]);
      await cx.execute(
        `INSERT INTO misc_fee_grades (misc_fee_id, grade_level) VALUES
          ${gradeLevels.map(() => '(?, ?)').join(',')}`,
        values
      );
    }
  });
  return getById(id);
}

/**
 * Patch a fee. Recomputes auto_apply from scope. Replaces the gradeLevels
 * join rows in full (clear + reinsert) since the membership can change
 * arbitrarily.
 */
async function update(id, patch) {
  const existing = await db.queryOne(
    'SELECT * FROM misc_fees WHERE id = ?', [id]
  );
  if (!existing) return null;

  const merged = {
    name:        patch.name        != null ? patch.name        : existing.name,
    amount:      patch.amount      != null ? Number(patch.amount) : existing.amount,
    category:    patch.category    != null ? patch.category    : existing.category,
    scope:       patch.scope       != null ? patch.scope       : existing.scope,
    description: patch.description != null ? patch.description : existing.description,
    schoolYear:  patch.schoolYear  != null ? patch.schoolYear  : existing.school_year,
    gradeLevels: Array.isArray(patch.gradeLevels)
      ? patch.gradeLevels
      : null
  };
  const autoApply = (merged.scope === 'school' || merged.scope === 'grades') ? 1 : 0;

  await db.withTransaction(async (cx) => {
    await cx.execute(
      `UPDATE misc_fees SET
          name = ?, amount = ?, category = ?, scope = ?, auto_apply = ?,
          description = ?, school_year = ?
        WHERE id = ?`,
      [
        merged.name, merged.amount, merged.category, merged.scope, autoApply,
        merged.description, merged.schoolYear, id
      ]
    );

    // Clear and re-insert the grade-level mapping if scope is 'grades' OR
    // if the caller provided a new list. If scope changed away from
    // 'grades', wipe the rows so they don't leak into the next read.
    if (merged.scope !== 'grades') {
      await cx.execute(
        'DELETE FROM misc_fee_grades WHERE misc_fee_id = ?', [id]
      );
    } else if (merged.gradeLevels !== null) {
      await cx.execute(
        'DELETE FROM misc_fee_grades WHERE misc_fee_id = ?', [id]
      );
      if (merged.gradeLevels.length) {
        const values = merged.gradeLevels.flatMap(g => [id, g]);
        await cx.execute(
          `INSERT INTO misc_fee_grades (misc_fee_id, grade_level) VALUES
            ${merged.gradeLevels.map(() => '(?, ?)').join(',')}`,
          values
        );
      }
    }
  });

  // Forward-apply: any newly-matching students get billed via
  // applySchoolWideFees, which is idempotent (skips already-applied).
  const retroAppliedToStudentIds = [];
  if (autoApply) {
    const allStudents = await db.query('SELECT id FROM students');
    for (const s of allStudents) {
      const before = await db.queryOne(
        `SELECT COUNT(*) AS n FROM charges
           WHERE student_id = ? AND misc_fee_id = ? AND is_archived = 0`,
        [s.id, id]
      );
      await studentsService.applySchoolWideFees(s.id);
      const after = await db.queryOne(
        `SELECT COUNT(*) AS n FROM charges
           WHERE student_id = ? AND misc_fee_id = ? AND is_archived = 0`,
        [s.id, id]
      );
      if ((after.n | 0) > (before.n | 0)) retroAppliedToStudentIds.push(s.id);
    }
  }

  return { fee: await getById(id), retroAppliedToStudentIds };
}

async function remove(id) {
  // FK ON DELETE CASCADE handles misc_fee_grades.
  // Existing charges referencing this fee remain (snapshot pricing) — we
  // intentionally leave the misc_fee_id pointing at a no-longer-existing
  // fee. This matches the original "remove from catalog only, don't
  // revoke billed charges" behavior.
  const [result] = await db.pool.execute(
    'DELETE FROM misc_fees WHERE id = ?', [id]
  );
  return result.affectedRows > 0;
}

module.exports = { getAll, getById, create, update, remove };
