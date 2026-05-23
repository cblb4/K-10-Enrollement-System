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
const studentsService = require('./studentsService');
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
  const isPhysical = row.received_method === 'physical';
  return {
    id:             row.id,
    documentType:   row.document_type,
    receivedMethod: row.received_method || 'uploaded',
    // ── Uploaded-only fields ──
    // For physical-only rows these come back as null; the frontend uses
    // receivedMethod to decide which UI to render. Once a scan is later
    // uploaded for a previously-physical row, these populate naturally
    // through the existing UPSERT in attachDocuments().
    originalName:   row.original_name,
    url:            isPhysical && !row.stored_path
                      ? null
                      : `/api/online-enrollment/documents/${row.id}/file`,
    mimeType:       row.mime_type,
    sizeBytes:      row.size_bytes,
    uploadedAt:     toIso(row.uploaded_at),
    // ── Physical-receipt fields ──
    // Populated only when the registrar manually logged a paper drop-off.
    // Preserved even if the row is later upgraded to 'uploaded', which
    // is intentional — the audit trail of how the document first arrived
    // is useful history.
    receivedBy:     row.received_by || null,
    receivedAt:     toIso(row.received_at)
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
          stored_path, mime_type, size_bytes, received_method
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded')
       ON DUPLICATE KEY UPDATE
          original_name   = VALUES(original_name),
          stored_path     = VALUES(stored_path),
          mime_type       = VALUES(mime_type),
          size_bytes      = VALUES(size_bytes),
          received_method = 'uploaded',
          uploaded_at     = NOW()`,
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

// ─── Physical receipts ───────────────────────────────────────────────────
//
// When a parent drops requirement documents off at the registrar's desk
// instead of uploading them, the registrar logs that here. The row uses
// the same enrollment_documents table — just with NULL file fields and
// received_method = 'physical'. The approval gate counts these the same
// as uploaded ones, so a student with all-physical paperwork can be
// approved without needing scans.
//
// A physical row can be "upgraded" later by uploading a scan: the UPSERT
// in attachDocuments() fills the file fields and flips received_method
// back to 'uploaded'. The original received_by / received_at columns
// stay populated as audit history.

async function markDocumentPhysical(studentId, documentType, receivedBy) {
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw new Error(`Unknown document type: ${documentType}`);
  }
  const student = await db.queryOne(
    'SELECT id FROM students WHERE id = ?', [studentId]
  );
  if (!student) return null;

  // UPSERT: if an uploaded row already exists for this (student, type),
  // we leave the file in place and just update the receipt metadata —
  // mark-as-physical on top of an uploaded doc effectively annotates
  // "we ALSO have the paper original on file." If no row exists, we
  // create a physical-only one with NULL file fields.
  await db.query(
    `INSERT INTO enrollment_documents (
        id, student_id, document_type,
        received_method, received_by, received_at
     ) VALUES (?, ?, ?, 'physical', ?, NOW())
     ON DUPLICATE KEY UPDATE
        received_method = CASE
          WHEN stored_path IS NOT NULL THEN received_method
          ELSE 'physical'
        END,
        received_by = VALUES(received_by),
        received_at = NOW()`,
    [generateId('doc'), studentId, documentType, receivedBy || null]
  );

  const row = await db.queryOne(
    'SELECT * FROM enrollment_documents WHERE student_id = ? AND document_type = ?',
    [studentId, documentType]
  );
  return rowToDocument(row);
}

/**
 * Remove a physical receipt mark. If the row is purely physical (no
 * file), the whole row is deleted — that doc returns to the Missing
 * state. If the row also has an uploaded file, we just clear the
 * physical-receipt metadata and keep the file intact.
 */
async function unmarkDocumentPhysical(studentId, documentType) {
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw new Error(`Unknown document type: ${documentType}`);
  }
  const row = await db.queryOne(
    'SELECT * FROM enrollment_documents WHERE student_id = ? AND document_type = ?',
    [studentId, documentType]
  );
  if (!row) return { removed: false };

  if (!row.stored_path) {
    // Physical-only — drop the row entirely.
    await db.query(
      'DELETE FROM enrollment_documents WHERE id = ?', [row.id]
    );
    return { removed: true, fullyDeleted: true };
  }
  // Has an uploaded file too — just clear the physical-receipt fields.
  await db.query(
    `UPDATE enrollment_documents
        SET received_method = 'uploaded', received_by = NULL, received_at = NULL
      WHERE id = ?`,
    [row.id]
  );
  return { removed: true, fullyDeleted: false };
}

// ─── Read / hydrate ──────────────────────────────────────────────────────

async function getGuardians(studentId) {
  const rows = await db.query(
    'SELECT * FROM student_guardians WHERE student_id = ?',
    [studentId]
  );
  return rows.map(rowToGuardian);
}

// ─── Guardian upsert / delete (used by the registrar's edit modal) ───────

const GUARDIAN_TYPES = ['father', 'mother', 'emergency'];

/**
 * Insert or update one guardian row for a student. The `(student_id,
 * guardian_type)` unique key is the natural upsert target — re-saving the
 * same parent block on the edit modal updates in place rather than
 * creating duplicates.
 *
 * `data` accepts the same camelCase shape rowToGuardian emits so the
 * frontend can echo back whatever it received from getSubmission().
 *
 * Returns the post-write guardian row (camelCase), or null if the
 * student doesn't exist.
 */
async function upsertGuardian(studentId, guardianType, data) {
  if (!GUARDIAN_TYPES.includes(guardianType)) {
    throw new Error(`Unknown guardian type: ${guardianType}`);
  }
  const student = await db.queryOne(
    'SELECT id FROM students WHERE id = ?', [studentId]
  );
  if (!student) return null;

  const g = data || {};
  // Empty strings → NULL so the column reads as 'unset' rather than ''.
  const norm = (s) => {
    if (s === undefined || s === null) return null;
    const t = String(s).trim();
    return t === '' ? null : t;
  };

  // INSERT ... ON DUPLICATE KEY UPDATE keeps the existing id stable if the
  // row already exists, which avoids reshuffling primary keys on edits.
  const newId = generateId('grd');
  await db.query(
    `INSERT INTO student_guardians (
        id, student_id, guardian_type,
        last_name, first_name, middle_name, full_name, relationship,
        home_address, religion, mobile_number, telephone_number
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        last_name        = VALUES(last_name),
        first_name       = VALUES(first_name),
        middle_name      = VALUES(middle_name),
        full_name        = VALUES(full_name),
        relationship     = VALUES(relationship),
        home_address     = VALUES(home_address),
        religion         = VALUES(religion),
        mobile_number    = VALUES(mobile_number),
        telephone_number = VALUES(telephone_number)`,
    [
      newId, studentId, guardianType,
      norm(g.lastName), norm(g.firstName), norm(g.middleName),
      norm(g.fullName), norm(g.relationship),
      norm(g.homeAddress), norm(g.religion),
      norm(g.mobileNumber), norm(g.telephoneNumber)
    ]
  );

  const row = await db.queryOne(
    'SELECT * FROM student_guardians WHERE student_id = ? AND guardian_type = ?',
    [studentId, guardianType]
  );
  return rowToGuardian(row);
}

/**
 * Delete a guardian row entirely. Used when the registrar clears a parent
 * block on the edit modal — emptying every field shouldn't leave an
 * all-NULL row behind. Returns true if a row was removed.
 */
async function removeGuardian(studentId, guardianType) {
  if (!GUARDIAN_TYPES.includes(guardianType)) {
    throw new Error(`Unknown guardian type: ${guardianType}`);
  }
  const [result] = await db.pool.execute(
    'DELETE FROM student_guardians WHERE student_id = ? AND guardian_type = ?',
    [studentId, guardianType]
  );
  return result.affectedRows > 0;
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

  // When an enrollment is approved, attach the school-wide + grade-specific
  // auto-apply misc fees so the cashier has something to collect against.
  // Runs OUTSIDE the status-update transaction so a fee-application error
  // doesn't roll back the approval itself — at worst the registrar (or
  // cashier) can retry via the "apply auto-fees" path. Idempotent: the
  // service skips fees that are already on the student.
  if (nextStatus === 'approved') {
    try {
      await studentsService.applySchoolWideFees(studentId);
    } catch (err) {
      // Log loudly but don't fail the approve response — the student IS
      // approved at this point and the cashier can re-trigger.
      console.error(
        '[onlineEnrollmentService.review] auto-fee application failed for',
        studentId, '—', err && err.message
      );
    }
  }

  return getSubmission(studentId);
}

const approve = (studentId, opts) => review(studentId, 'approved', opts);
const reject  = (studentId, opts) => review(studentId, 'rejected', opts);

module.exports = {
  DOCUMENT_TYPES,
  GUARDIAN_TYPES,
  submit,
  attachDocuments,
  getDocuments,
  getDocumentRow,
  getSubmission,
  listPending,
  approve,
  reject,
  upsertGuardian,
  removeGuardian,
  markDocumentPhysical,
  unmarkDocumentPhysical
};
