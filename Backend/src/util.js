/**
 * util.js — shared helpers (ID generation, row → object mapping).
 *
 * The frontend code base uses prefixed IDs everywhere (stu_, mf_, chg_, …).
 * We keep the same scheme on the server so IDs flowing in either direction
 * are interchangeable, and so existing module code that assumes this format
 * (e.g., the receipt prints "Receipt #" + lastChunk(payment.id)) keeps working.
 *
 * The ROW_TO_JS_* helpers convert MySQL snake_case columns to the camelCase
 * shape the frontend expects. This is the only "ORM" layer in this app.
 */
'use strict';

const crypto = require('crypto');

function generateId(prefix) {
  // Roughly mirrors the original storage.js generateId():
  //   <prefix>_<timestamp>_<6-char-random>
  // Using crypto.randomBytes instead of Math.random for collision resistance
  // — important once you have many writes per second.
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${prefix}_${time}_${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Row mappers ─────────────────────────────────────────────────────────
// Each maps a single DB row to the shape the frontend expects. Keeping
// these centralized means schema column tweaks don't ripple through every
// controller.

function rowToUser(row) {
  if (!row) return null;
  return {
    id:         row.id,
    fullName:   row.full_name,
    email:      row.email,
    role:       row.role,
    createdAt:  toIso(row.created_at)
    // password_hash intentionally NEVER returned
  };
}

function rowToSection(row) {
  if (!row) return null;
  return {
    id:          row.id,
    name:        row.name,
    gradeLevel:  row.grade_level,
    adviser:     row.adviser,
    capacity:    row.capacity,
    createdAt:   toIso(row.created_at)
  };
}

function rowToFaculty(row) {
  if (!row) return null;
  return {
    id:           row.id,
    firstName:    row.first_name,
    lastName:     row.last_name,
    position:     row.position,
    department:   row.department,
    email:        row.email,
    contact:      row.contact,
    photoDataUrl: row.photo_data_url,
    createdAt:    toIso(row.created_at)
  };
}

function rowToSubject(row) {
  if (!row) return null;
  return {
    id:          row.id,
    name:        row.name,
    gradeLevel:  row.grade_level,
    fee:         numOrZero(row.fee),
    description: row.description || '',
    createdAt:   toIso(row.created_at)
  };
}

/**
 * Build a student object including its `charges[]` and `archivedCharges[]`
 * subarrays — matches the original embedded-array shape so the frontend
 * doesn't need to learn a new schema.
 *
 * @param {object} row    — students table row
 * @param {Array}  charges — already-fetched charges for this student
 *                           (active rows; is_archived = 0)
 * @param {Array}  archivedCharges — same for archived rows
 */
function rowToStudent(row, charges, archivedCharges) {
  if (!row) return null;
  const discount = (row.discount_label || row.discount_amount != null || row.discount_percent != null)
    ? {
        label:   row.discount_label || '',
        amount:  row.discount_amount  != null ? numOrZero(row.discount_amount)  : null,
        percent: row.discount_percent != null ? numOrZero(row.discount_percent) : null
      }
    : null;

  return {
    id:             row.id,
    firstName:      row.first_name,
    lastName:       row.last_name,
    middleName:     row.middle_name || '',
    birthDate:      row.birth_date || null,    // 'YYYY-MM-DD' string thanks to dateStrings: ['DATE']
    gender:         row.gender || '',
    gradeLevel:     row.grade_level,
    guardianName:   row.guardian_name,
    contact:        row.contact,
    address:        row.address,
    notes:          row.notes || '',
    status:         row.status,
    // ── Two-phase approval flag (migration 005) ──────────────────────────
    // True when the registrar has approved the learner in principle but
    // some required documents are still missing — status stays 'pending'
    // until the last document arrives, then the service layer auto-flips
    // status to 'approved' and clears this flag. Frontend uses it to show
    // an "Approval Pending Documents" sub-badge in the directory.
    pendingApproval: !!row.pending_approval,
    paymentStatus:  row.payment_status,
    paymentMode:    row.payment_mode,
    section:        row.section_id || null,
    schoolYear:     row.school_year,
    discount,
    // ── Online Enrollment Module fields (migration 002) ──────────────────
    // Additive only — existing consumers (GSA, cashier, etc.) ignore these;
    // the registrar's Student Records detail view reads them when present.
    enrollmentSource:   row.enrollment_source || 'walk-in',
    program:            row.program || '',
    schoolLastAttended: row.school_last_attended || '',
    enrollmentDate:     row.enrollment_date || null,
    shuttleService:     !!row.shuttle_service,
    carpoolService:     row.carpool_service || '',
    escGrantee:         !!row.esc_grantee,
    submittedAt:        toIso(row.submitted_at),
    reviewedAt:         toIso(row.reviewed_at),
    reviewedBy:         row.reviewed_by || null,
    rejectionReason:    row.rejection_reason || null,
    charges:         (charges || []).map(rowToCharge),
    archivedCharges: (archivedCharges || []).map(rowToCharge),
    createdAt:      toIso(row.created_at),
    updatedAt:      toIso(row.updated_at)
  };
}

function rowToCharge(row) {
  if (!row) return null;
  const out = {
    chargeId:    row.charge_id,
    title:       row.title,
    amount:      numOrZero(row.amount),
    description: row.description || '',
    source:      row.source,
    subjectId:   row.subject_id    || null,
    miscFeeId:   row.misc_fee_id   || null,
    feeScope:    row.fee_scope     || null,
    category:    row.category      || null,
    schoolYear:  row.school_year   || null,
    status:      row.status,
    paymentId:   row.payment_id    || null,
    paidAt:      toIso(row.paid_at),
    createdAt:   toIso(row.created_at)
  };
  if (row.is_carry_over) {
    out.isCarryOver        = true;
    out.originalGradeLevel = row.original_grade_level;
    out.originalSchoolYear = row.original_school_year;
    out.carriedOverAt      = toIso(row.carried_over_at);
  }
  if (row.is_archived) {
    out.archivedAt              = toIso(row.archived_at);
    out.archiveReason           = row.archive_reason;
    out.archivedFromGrade       = row.archived_from_grade;
    out.archivedFromSchoolYear  = row.archived_from_school_year;
  }
  return out;
}

function rowToPayment(row, chargeIds) {
  if (!row) return null;
  return {
    id:               row.id,
    studentId:        row.student_id,
    amount:           numOrZero(row.amount),
    discountAmount:   numOrZero(row.discount_amount),
    discountLabel:    row.discount_label   || '',
    discountPercent:  row.discount_percent != null ? numOrZero(row.discount_percent) : null,
    method:           row.method,
    reference:        row.reference        || '',
    receivedBy:       row.received_by      || 'cashier',
    schoolYear:       row.school_year,
    chargeIds:        chargeIds || [],
    voidedAt:         toIso(row.voided_at),
    voidReason:       row.void_reason      || null,
    voidedBy:         row.voided_by        || null,
    createdAt:        toIso(row.created_at)
  };
}

function rowToMiscFee(row, gradeLevels) {
  if (!row) return null;
  return {
    id:           row.id,
    name:         row.name,
    amount:       numOrZero(row.amount),
    category:     row.category || '',
    scope:        row.scope,
    autoApply:    !!row.auto_apply,
    description:  row.description || '',
    schoolYear:   row.school_year,
    gradeLevels:  Array.isArray(gradeLevels) ? gradeLevels : [],
    createdAt:    toIso(row.created_at)
  };
}

function rowToActivity(row) {
  if (!row) return null;
  return {
    id:        row.id,
    role:      row.role,
    action:    row.action,
    details:   row.details || '',
    timestamp: toIso(row.timestamp)
  };
}

// ─── small primitive helpers ─────────────────────────────────────────────
function numOrZero(n) {
  if (n === null || n === undefined) return 0;
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function toIso(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;     // already stringified
  if (val instanceof Date)     return val.toISOString();
  return null;
}

module.exports = {
  generateId,
  nowIso,
  rowToUser,
  rowToSection,
  rowToFaculty,
  rowToSubject,
  rowToStudent,
  rowToCharge,
  rowToPayment,
  rowToMiscFee,
  rowToActivity
};
