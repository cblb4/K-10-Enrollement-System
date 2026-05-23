/**
 * publicEnrollment.controller.js — the Online Enrollment Module's endpoints.
 *
 * Two audiences, two trust levels:
 *
 *   PUBLIC (no auth) — used by Front-end/enroll.html:
 *     - submit()          POST /api/online-enrollment/submit
 *     - uploadDocuments() POST /api/online-enrollment/:id/documents
 *
 *   REGISTRAR (auth) — used by the registrar module's new view:
 *     - listSubmissions() GET  /api/online-enrollment/submissions
 *     - getSubmission()   GET  /api/online-enrollment/submissions/:id
 *     - approve()         POST /api/online-enrollment/submissions/:id/approve
 *     - reject()          POST /api/online-enrollment/submissions/:id/reject
 *     - downloadDocument()GET  /api/online-enrollment/documents/:docId/file
 *
 * Because the public endpoints are unauthenticated, EVERY field is validated
 * with the existing `expect()` helper and unknown fields are simply ignored
 * (the service only reads the keys it knows). Submission status is forced to
 * 'pending' server-side — a parent cannot self-approve.
 */
'use strict';

const fs = require('fs');
const service = require('../services/onlineEnrollmentService');
const settingsService = require('../services/settingsService');
const fileStorage = require('../services/fileStorage');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect } = require('../middleware/validate');

const GENDERS = ['Male', 'Female', 'Other'];

// ─── Public: school-year list (for the public form's default dropdown) ───

const schoolYears = asyncHandler(async (_req, res) => {
  const active = await settingsService.getActiveSchoolYear();
  let known = await settingsService.get('knownSchoolYears', []);
  if (!Array.isArray(known)) known = [];
  // The active year is always part of the list.
  if (known.indexOf(active) === -1) known.push(active);
  known.sort();
  res.json({ activeSchoolYear: active, schoolYears: known });
});

// ─── Public: submit a new enrollment ─────────────────────────────────────

const submit = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Top-level enrollment info.
  expect(body, {
    program:    { type: 'string', max: 120 },
    gradeLevel: { type: 'string', max: 40 },
    schoolYear:     { type: 'string', max: 20, optional: true },
    enrollmentDate: { type: 'string', max: 20, optional: true }
  });

  // Learner's information.
  const learner = body.learner || {};
  expect(learner, {
    lastName:   { type: 'string', max: 100 },
    firstName:  { type: 'string', max: 100 },
    middleName: { type: 'string', max: 100, optional: true },
    birthDate:  { type: 'string', max: 20 },
    gender:     { type: 'enum', values: GENDERS },
    schoolLastAttended: { type: 'string', max: 200, optional: true }
  });

  // Father / mother — at least one parent must be supplied.
  const hasFather = body.father && (body.father.firstName || body.father.lastName);
  const hasMother = body.mother && (body.mother.firstName || body.mother.lastName);
  if (!hasFather && !hasMother) {
    throw new HttpError(400, 'Validation failed', {
      parents: "At least one parent's information is required"
    });
  }
  if (hasFather) {
    expect(body.father, {
      lastName:     { type: 'string', max: 100 },
      firstName:    { type: 'string', max: 100 },
      middleName:   { type: 'string', max: 100, optional: true },
      homeAddress:  { type: 'string' },
      religion:     { type: 'string', max: 100, optional: true },
      mobileNumber: { type: 'string', max: 50 },
      telephoneNumber: { type: 'string', max: 50, optional: true }
    });
  }
  if (hasMother) {
    expect(body.mother, {
      lastName:     { type: 'string', max: 100 },
      firstName:    { type: 'string', max: 100 },
      middleName:   { type: 'string', max: 100, optional: true },
      homeAddress:  { type: 'string' },
      religion:     { type: 'string', max: 100, optional: true },
      mobileNumber: { type: 'string', max: 50 },
      telephoneNumber: { type: 'string', max: 50, optional: true }
    });
  }

  // Emergency contact — required.
  expect(body.emergency || {}, {
    fullName:     { type: 'string', max: 200 },
    mobileNumber: { type: 'string', max: 50 },
    relationship: { type: 'string', max: 100 },
    homeAddress:  { type: 'string' }
  });

  // Other information — conditional logic: carpool service required only
  // when the shuttle service is requested.
  const other = body.other || {};
  if (other.shuttleService) {
    expect(other, {
      carpoolService: { type: 'string', max: 40 }
    });
  }

  const submission = await service.submit(body);
  // 201 + the new id so the form can immediately upload its documents.
  res.status(201).json(submission);
});

// ─── Public: upload requirement documents for a submission ───────────────
//
// Multipart — multer puts files on req.files. Each file's `fieldname` is the
// document type (e.g. "report_card"). The route wires multer in routes.js.

const uploadDocuments = asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    throw new HttpError(400, 'No files were uploaded');
  }
  const items = files.map(f => ({ documentType: f.fieldname, file: f }));

  let docs;
  try {
    docs = await service.attachDocuments(req.params.id, items);
  } catch (err) {
    if (/Unknown document type/.test(err.message)) {
      throw new HttpError(400, err.message);
    }
    throw err;
  }
  if (docs === null) throw new HttpError(404, 'Submission not found');
  res.json({ documents: docs });
});

// ─── Registrar: list / view submissions ──────────────────────────────────

const listSubmissions = asyncHandler(async (req, res) => {
  // ?status=pending (default) | approved | rejected | all
  const status = req.query.status || 'pending';
  res.json(await service.listPending(status));
});

const getSubmission = asyncHandler(async (req, res) => {
  const submission = await service.getSubmission(req.params.id);
  if (!submission) throw new HttpError(404, 'Submission not found');
  res.json(submission);
});

// ─── Registrar: approve / reject ─────────────────────────────────────────

const approve = asyncHandler(async (req, res) => {
  const result = await service.approve(req.params.id, {
    reviewedBy: req.user && req.user.email ? req.user.email : 'registrar'
  });
  if (!result) throw new HttpError(404, 'Submission not found');
  res.json(result);
});

const reject = asyncHandler(async (req, res) => {
  expect(req.body || {}, { reason: { type: 'string', max: 500 } });
  const result = await service.reject(req.params.id, {
    reason:     req.body.reason,
    reviewedBy: req.user && req.user.email ? req.user.email : 'registrar'
  });
  if (!result) throw new HttpError(404, 'Submission not found');
  res.json(result);
});

// ─── Registrar: download one document (auth-gated) ───────────────────────

const downloadDocument = asyncHandler(async (req, res) => {
  const row = await service.getDocumentRow(req.params.docId);
  if (!row) throw new HttpError(404, 'Document not found');

  // Physical-only rows have no file to serve. Frontend already hides
  // the link in that case (rowToDocument returns url=null), but if a
  // direct request slips through we give a clear 404 rather than
  // letting absolutePathFor crash on a null path.
  if (!row.stored_path) {
    throw new HttpError(
      404,
      'No file attached — this document was logged as physically received'
    );
  }

  const absPath = fileStorage.absolutePathFor(row.stored_path);
  if (!fs.existsSync(absPath)) {
    throw new HttpError(404, 'Document file is missing on the server');
  }
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${row.original_name.replace(/"/g, '')}"`
  );
  fs.createReadStream(absPath).pipe(res);
});

// ─── Registrar: edit a single guardian (father / mother / emergency) ─────
//
// Used by the Student Directory's Edit modal so the registrar can fix
// parent / emergency contact details without re-submitting the whole
// online form. PATCH because it's a partial upsert.

const GUARDIAN_TYPES = ['father', 'mother', 'emergency'];

const upsertGuardian = asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  if (!GUARDIAN_TYPES.includes(type)) {
    throw new HttpError(400, `Unknown guardian type: ${type}`);
  }
  // Soft validation — every field is optional, but if firstName/lastName
  // and homeAddress are all empty we route to delete instead.
  const body = req.body || {};
  const everythingEmpty = !['lastName','firstName','middleName','fullName',
                            'relationship','homeAddress','religion',
                            'mobileNumber','telephoneNumber']
      .some(k => body[k] && String(body[k]).trim());

  if (everythingEmpty) {
    const removed = await service.removeGuardian(id, type);
    return res.json({ removed, guardian: null });
  }

  const guardian = await service.upsertGuardian(id, type, body);
  if (!guardian) throw new HttpError(404, 'Student not found');
  res.json({ guardian });
});

const deleteGuardian = asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  if (!GUARDIAN_TYPES.includes(type)) {
    throw new HttpError(400, `Unknown guardian type: ${type}`);
  }
  const removed = await service.removeGuardian(id, type);
  res.json({ removed });
});

// ─── Registrar: log a physically-received document ───────────────────────
// When a parent drops paperwork off at the desk, the registrar marks the
// document type as received here. No file is uploaded; the row carries
// the receiver's name and a timestamp so the audit trail is preserved.

const markDocumentPhysical = asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  // Use the logged-in registrar's email as a fall-back; the request can
  // optionally override (e.g. "Received by Jane Doe at front desk").
  const receivedBy = (req.body && req.body.receivedBy)
    || (req.user && req.user.email)
    || 'registrar';

  let doc;
  try {
    doc = await service.markDocumentPhysical(id, type, receivedBy);
  } catch (err) {
    if (/Unknown document type/.test(err.message)) {
      throw new HttpError(400, err.message);
    }
    throw err;
  }
  if (!doc) throw new HttpError(404, 'Student not found');
  res.json({ document: doc });
});

const unmarkDocumentPhysical = asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  let result;
  try {
    result = await service.unmarkDocumentPhysical(id, type);
  } catch (err) {
    if (/Unknown document type/.test(err.message)) {
      throw new HttpError(400, err.message);
    }
    throw err;
  }
  res.json(result);
});

module.exports = {
  schoolYears,
  submit,
  uploadDocuments,
  listSubmissions,
  getSubmission,
  approve,
  reject,
  downloadDocument,
  upsertGuardian,
  deleteGuardian,
  markDocumentPhysical,
  unmarkDocumentPhysical
};
