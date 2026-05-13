/**
 * promotionService.js — changeStudentGrade.
 *
 * Implements the two-flavor grade change from storage.js#changeStudentGrade:
 *
 *   reason='correction' — typo / mis-keyed grade. Just patch the field.
 *
 *   reason='promotion'  — student is moving up. Roll over the ledger:
 *     · subjects → archived
 *     · paid non-subject charges → archived
 *     · unpaid non-subject charges → kept active, tagged is_carry_over=1
 *     · already-carried-over charges → left in place
 *   Then auto-apply the new grade/SY's school-wide & grade-targeted fees.
 *
 * Returns:
 *   { student, appliedFees, archivedCount, carryOverCount, carryOverAmount }
 */
'use strict';

const db = require('../db');
const studentsService = require('./studentsService');

async function changeStudentGrade(studentId, newGrade, options) {
  options = options || {};
  if (!newGrade) return null;

  // Phase 1: do the row work in a transaction.
  const result = await db.withTransaction(async (cx) => {
    const [stuRows] = await cx.execute(
      'SELECT * FROM students WHERE id = ?', [studentId]
    );
    if (!stuRows.length) return null;
    const student = stuRows[0];

    let archivedCount = 0;
    let carryOverCount = 0;
    let carryOverAmount = 0;

    if (options.reason === 'promotion') {
      const previousGrade = student.grade_level;
      const previousSY    = student.school_year || null;
      const promotedAt    = new Date();

      const [activeCharges] = await cx.execute(
        `SELECT * FROM charges
           WHERE student_id = ? AND is_archived = 0`,
        [studentId]
      );

      for (const c of activeCharges) {
        // Already a carry-over from a prior promotion → leave alone.
        if (c.is_carry_over) {
          if (c.status !== 'paid') {
            carryOverCount++;
            carryOverAmount += Number(c.amount) || 0;
          }
          continue;
        }
        // Subjects always archive (zero-amount academic records).
        if (c.source === 'subject') {
          await cx.execute(
            `UPDATE charges SET
                is_archived = 1, archived_at = ?, archive_reason = 'promotion',
                archived_from_grade = ?, archived_from_school_year = ?
              WHERE charge_id = ?`,
            [promotedAt, previousGrade, previousSY, c.charge_id]
          );
          archivedCount++;
          continue;
        }
        // Settled non-subject charges → archive as history.
        if (c.status === 'paid') {
          await cx.execute(
            `UPDATE charges SET
                is_archived = 1, archived_at = ?, archive_reason = 'promotion',
                archived_from_grade = ?, archived_from_school_year = ?
              WHERE charge_id = ?`,
            [promotedAt, previousGrade, previousSY, c.charge_id]
          );
          archivedCount++;
          continue;
        }
        // Unpaid non-subject charge → mark as carry-over but keep active.
        await cx.execute(
          `UPDATE charges SET
              is_carry_over = 1,
              original_grade_level = COALESCE(original_grade_level, ?),
              original_school_year = COALESCE(original_school_year, ?),
              carried_over_at = ?
            WHERE charge_id = ?`,
          [previousGrade, previousSY, promotedAt, c.charge_id]
        );
        carryOverCount++;
        carryOverAmount += Number(c.amount) || 0;
      }
    }

    // Patch the student.
    const updates = ['grade_level = ?'];
    const values = [newGrade];
    if (options.reason === 'promotion' && options.newSchoolYear) {
      updates.push('school_year = ?');
      values.push(options.newSchoolYear);
    }
    values.push(studentId);
    await cx.execute(
      `UPDATE students SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    return { archivedCount, carryOverCount, carryOverAmount };
  });

  if (!result) return null;

  // Phase 2: apply auto-apply fees for the new grade/SY context.
  let appliedFees = [];
  if (options.reason === 'promotion') {
    const { applied } = await studentsService.applySchoolWideFees(studentId);
    appliedFees = applied;
  }

  return {
    student: await studentsService.getById(studentId),
    appliedFees,
    archivedCount: result.archivedCount,
    carryOverCount: result.carryOverCount,
    carryOverAmount: result.carryOverAmount
  };
}

module.exports = { changeStudentGrade };
