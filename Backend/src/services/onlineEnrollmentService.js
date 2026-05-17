/**
 * onlineEnrollmentService.js — business logic for the Online Enrollment Module.
 *
 * Responsibilities:
 *   - submit()          : insert a public submission as a 'pending' student
 *                         plus its guardian rows, inside one transaction.
 *   - attachDocuments() : record uploaded requirement files for a student.
 *   - listPending()     : the registrar's "Online Submissions" queue.
 *   - getSubmission()   : one submission, fully hydrated (student +
 *                         guardians + documents).
 *   - approve()/reject(): registrar review actions, with activity logging.
 *
 * Design notes:
 *   - A public submission is ALWAYS forced to status='pending',
 *     enrollment_source='online'. Client-supplied status / section /
 *     payment fields are ignored — this endpoint is unauthenticated and
 *     must be treated as hostile input.
 *   - The walk-in `students` columns guardian_name / contact / address are
 *     back-filled from the father (preferred) or mother row so the existing
 *     registrar UI keeps rendering a sensible "guardian" with no changes.
 *   - File bytes are handled by fileStorage (swappable disk/S3 layer); this
 *     service only ever touches the returned relative path.
 */
'use strict';

const db = require('../db');
const { generateId } = require('../util');
const settingsService = require('./settingsService');
const fileStorage = require('./fileStorage');

const DOCUMENT_TYPES = [
  'affidavit_of_undertaking',
  'report_card',
  'good_moral',
  'psa_birth_certificate',
  'doctors_advice',
  'sbt_result',
  'flu_vaccine_certificate',
  'valid_id'
];

// ─── Local row mappers ───────────────────────────────────────────────────
// Kept here (not in util.js) so util.js stays focused on the original v1
// shapes — these belong to the online-enrollment feature.

function rowToGuardian(row) {
  if (!row) return null;
  return {
    id:              row.id,
    guardianType:    row.guardian_type,
    lastName:        row.last_name || '',
    firstName:       row.first_name || '',
    middleName:      row.middle_name || '',
    fullName:        row.full_name || '',
    relationship:    row.relationship || '',
    homeAddress:     row.home_address || '',
    religion:        row.religion || '',
    mobileNumber:    row.mobile_number || '',
    telephoneNumber: row.telephone_number || ''
  };
}

function rowToDocument(row) {
  if (!row) return null;
  return {
    id:           row.id,
    documentType: row.document_type,
    originalName: row.original_name,
    // Authenticated download route (see routes.js). Kept as a single `url`
    // field so an S3 swap (pre-signed URLs) stays invisible to the frontend.
    url:          `/api/online-enrollment/documents/${row.id}/file`,
    mimeType:     row.mime_type,
    sizeBytes:    row.size_bytes,
    uploadedAt:   toIso(row.uploaded_at)
  };
}

function toIso(val) {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function computeAge(birthDate) {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age >= 0 ? age : null;
}

// ─── Submission ──────────────────────────────────────────────────────────

/**
 * Insert one online enrollment submission as a pending student + guardians.
 *
 * @param {object} input — validated public-form payload (see controller).
 * @returns {Promise<object>} the created submission, fully hydrated.
 */
async function submit(input) {
  const studentId = generateId('stu');
  const sy = input.schoolYear || await settingsService.getActiveSchoolYear();
  const learner = input.learner || {};
  const other   = input.other   || {};

  // Back-fill the legacy single-guardian columns from the father, falling
  // back to the mother, so existing registrar screens still show something.
  const primary = input.father && input.father.firstName ? input.father
                : input.mother && input.mother.firstName ? input.mother
                : null;
  const primaryName = primary
    ? [primary.firstName, primary.lastName].filter(Boolean).join(' ')
    : 'Online submission';
  const primaryContact = primary && primary.mobileNumber ? primary.mobileNumber : '';
  const primaryAddress = primary && primary.homeAddress ? primary.homeAddress : '';

  await db.withTransaction(async (cx) => {
    await cx.execute(
      `INSERT INTO students (
          id, first_name, last_name, middle_name, birth_date, gender,
          grade_level, guardian_name, contact, address, notes,
          status, payment_status, payment_mode, section_id, school_year,
          enrollment_source, program, school_last_attended, enrollment_date,
          shuttle_service, carpool_service, esc_grantee,
          submitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'pending', 'unpaid', 'full', NULL, ?,
                 'online', ?, ?, ?, ?, ?, ?, NOW())`,
      [
        studentId,
        learner.firstName, learner.lastName, learner.middleName || null,
        learner.birthDate || null, learner.gender || null,
        input.gradeLevel,
        primaryName, primaryContact, primaryAddress,
        null,                                   // notes
        sy,
        input.program || null,
        learner.schoolLastAttended || null,
        input.enrollmentDate || null,
        other.shuttleService ? 1 : 0,
        other.shuttleService ? (other.carpoolService || null) : null,
        other.escGrantee ? 1 : 0
      ]
    );

    // Guardian rows — only insert the ones actually supplied.
    const guardianInserts = [];
    if (input.father && (input.father.firstName || input.father.lastName)) {
      guardianInserts.push(['father', input.father]);
    }
    if (input.mother && (input.mother.firstName || input.mother.lastName)) {
      guardianInserts.push(['mother', input.mother]);
    }
    if (input.emergency && input.emergency.fullName) {
      guardianInserts.push(['emergency', input.emergency]);
    }

    for (const [type, g] of guardianInserts) {
      await cx.execute(
        `INSERT INTO student_guardians (
            id, student_id, guardian_type,
            last_name, first_name, middle_name, full_name, relationship,
            home_address, religion, mobile_number, telephone_number
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId('grd'), studentId, type,
          g.lastName || null, g.firstName || null, g.middleName || null,
          g.fullName || null, g.relationship || null,
          g.homeAddress || null, g.religion || null,
          g.mobileNumber || null, g.telephoneNumber || null
        ]
      );
    }
  });

  return getSubmission(studentId);
}

// ─── Documents ───────────────────────────────────────────────────────────

/**
 * Persist uploaded requirement files and record them for a student.
 * Re-uploading a document type replaces the previous file (the old disk
 * file is removed; the row is upserted via the UNIQUE key).
 *
 * @param {string} studentId
 * @param {Array<{documentType, file}>} items — file is a multer file object.
 * @returns {Promise<Array>} the recorded document rows (mapped).
 */
async function attachDocuments(studentId, items) {
  const student = await db.queryOne('SELECT id FROM students WHERE id = ?', [studentId]);
  if (!student) return null;

  for (const { documentType, file } of items) {
    if (!DOCUMENT_TYPES.includes(documentType)) {
      throw new Error(`Unknown document type: ${documentType}`);
    }
    // Remove any existing file for this (student, type) before replacing.
    const prev = await db.queryOne(
      'SELECT stored_path FROM enrollment_documents WHERE student_id = ? AND document_type = ?',
      [studentId, documentType]
    );

    const { storedPath } = await fileStorage.save(file);

    await db.query(
      `INSERT INTO enrollment_documents (
          id, student_id, document_type, original_name,
          stored_path, mime_type, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          original_name = VALUES(original_name),
          stored_path   = VALUES(stored_path),
          mime_type     = VALUES(mime_type),
          size_bytes    = VALUES(size_bytes),
          uploaded_at   = NOW()`,
      [
        generateId('doc'), studentId, documentType,
        file.originalname, storedPath, file.mimetype, file.size
      ]
    );

    if (prev && prev.stored_path) {
      await fileStorage.remove(prev.stored_path);
    }
  }

  return getDocuments(studentId);
}

async function getDocuments(studentId) {
  const rows = await db.query(
    'SELECT * FROM enrollment_documents WHERE student_id = ? ORDER BY document_type',
    [studentId]
  );
  return rows.map(rowToDocument);
}

/** Fetch one document row (for the authenticated file-download route). */
async function getDocumentRow(documentId) {
  return db.queryOne('SELECT * FROM enrollment_documents WHERE id = ?', [documentId]);
}

// ─── Read / hydrate ──────────────────────────────────────────────────────

async function getGuardians(studentId) {
  const rows = await db.query(
    'SELECT * FROM student_guardians WHERE student_id = ?',
    [studentId]
  );
  return rows.map(rowToGuardian);
}

/**
 * One submission, fully hydrated: the student row plus its guardians and
 * documents, with derived `age`.
 */
async function getSubmission(studentId) {
  const row = await db.queryOne('SELECT * FROM students WHERE id = ?', [studentId]);
  if (!row) return null;

  const [guardians, documents] = await Promise.all([
    getGuardians(studentId),
    getDocuments(studentId)
  ]);

  const byType = {};
  for (const g of guardians) byType[g.guardianType] = g;

  return {
    id:                 row.id,
    status:             row.status,
    enrollmentSource:   row.enrollment_source,
    schoolYear:         row.school_year,
    program:            row.program || '',
    gradeLevel:         row.grade_level,
    enrollmentDate:     row.enrollment_date || null,
    learner: {
      lastName:           row.last_name,
      firstName:          row.first_name,
      middleName:         row.middle_name || '',
      birthDate:          row.birth_date || null,
      age:                computeAge(row.birth_date),
      gender:             row.gender || '',
      schoolLastAttended: row.school_last_attended || ''
    },
    other: {
      shuttleService: !!row.shuttle_service,
      carpoolService: row.carpool_service || '',
      escGrantee:     !!row.esc_grantee
    },
    father:    byType.father    || null,
    mother:    byType.mother    || null,
    emergency: byType.emergency || null,
    documents,
    submittedAt:      toIso(row.submitted_at),
    reviewedAt:       toIso(row.reviewed_at),
    reviewedBy:       row.reviewed_by || null,
    rejectionReason:  row.rejection_reason || null
  };
}

/**
 * The registrar's "Online Submissions" queue. Defaults to pending only;
 * pass status='all' to include reviewed ones.
 */
async function listPending(status) {
  let sql = `SELECT id FROM students WHERE enrollment_source = 'online'`;
  const params = [];
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY submitted_at DESC';
  const rows = await db.query(sql, params);
  return Promise.all(rows.map(r => getSubmission(r.id)));
}

// ─── Review actions ──────────────────────────────────────────────────────

async function review(studentId, nextStatus, opts) {
  opts = opts || {};
  const row = await db.queryOne(
    `SELECT id FROM students WHERE id = ? AND enrollment_source = 'online'`,
    [studentId]
  );
  if (!row) return null;

  await db.withTransaction(async (cx) => {
    await cx.execute(
      `UPDATE students
          SET status = ?, reviewed_at = NOW(), reviewed_by = ?,
              rejection_reason = ?
        WHERE id = ?`,
      [
        nextStatus,
        opts.reviewedBy || 'registrar',
        nextStatus === 'rejected' ? (opts.reason || null) : null,
        studentId
      ]
    );
    await cx.execute(
      `INSERT INTO activity_log (id, role, action, details)
         VALUES (?, ?, ?, ?)`,
      [
        generateId('act'),
        'registrar',
        nextStatus === 'approved' ? 'Approved online enrollment'
                                  : 'Rejected online enrollment',
        `Student ${studentId}` +
          (nextStatus === 'rejected' && opts.reason ? ` — ${opts.reason}` : '')
      ]
    );
  });

  return getSubmission(studentId);
}

const approve = (studentId, opts) => review(studentId, 'approved', opts);
const reject  = (studentId, opts) => review(studentId, 'rejected', opts);

module.exports = {
  DOCUMENT_TYPES,
  submit,
  attachDocuments,
  getDocuments,
  getDocumentRow,
  getSubmission,
  listPending,
  approve,
  reject
};
