/**
 * students.controller.js — student CRUD plus charge / fee / promotion ops.
 *
 * Most of the heavy lifting (transactions, hydration, business logic)
 * lives in the service layer; controllers do validation, status mapping,
 * and 404 handling.
 */
'use strict';

const studentsService = require('../services/studentsService');
const promotionService = require('../services/promotionService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const {
  expect,
  STUDENT_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_MODES
} = require('../middleware/validate');

// ─── Read ────────────────────────────────────────────────────────────────

const list = asyncHandler(async (_req, res) => {
  res.json(await studentsService.getAll());
});

const getOne = asyncHandler(async (req, res) => {
  const student = await studentsService.getById(req.params.id);
  if (!student) throw new HttpError(404, 'Student not found');
  res.json(student);
});

// ─── Create / Update / Delete ────────────────────────────────────────────

const create = asyncHandler(async (req, res) => {
  // Required fields per the registrar's "Add student" form.
  expect(req.body, {
    firstName:    { type: 'string', max: 100 },
    lastName:     { type: 'string', max: 100 },
    gradeLevel:   { type: 'string', max: 40 },
    guardianName: { type: 'string', max: 200 },
    contact:      { type: 'string', max: 50 },
    address:      { type: 'string' },
    // Optional — present here so we can validate the enum if supplied.
    status:        { type: 'enum', values: STUDENT_STATUSES, optional: true },
    paymentStatus: { type: 'enum', values: PAYMENT_STATUSES, optional: true },
    paymentMode:   { type: 'enum', values: PAYMENT_MODES,    optional: true }
  });

  const student = await studentsService.create(req.body);

  // If the new student lands directly in an approved/enrolled state (e.g.
  // bulk import, registrar shortcut), attach school-wide + grade-specific
  // auto-apply misc fees so the cashier has something to bill against.
  // 'pending' / 'rejected' students don't get fees — they're not real
  // enrollees yet (or never will be). Best-effort: a fee-apply failure
  // mustn't break the create response.
  if (student && (student.status === 'approved' || student.status === 'enrolled')) {
    try {
      const r = await studentsService.applySchoolWideFees(student.id);
      // Return the post-fee-apply student so the client sees the new charges
      // in the same response, no extra round-trip needed.
      if (r && r.student) {
        return res.status(201).json(r.student);
      }
    } catch (err) {
      console.error(
        '[students.create] auto-fee application failed for',
        student.id, '—', err && err.message
      );
    }
  }

  res.status(201).json(student);
});

const update = asyncHandler(async (req, res) => {
  // Light enum check on whatever happens to be in the patch.
  if (req.body.status !== undefined) {
    expect(req.body, { status: { type: 'enum', values: STUDENT_STATUSES } });
  }
  if (req.body.paymentStatus !== undefined) {
    expect(req.body, { paymentStatus: { type: 'enum', values: PAYMENT_STATUSES } });
  }
  if (req.body.paymentMode !== undefined) {
    expect(req.body, { paymentMode: { type: 'enum', values: PAYMENT_MODES } });
  }

  // Read the prior status BEFORE patching so we can detect a transition
  // *into* approved/enrolled. We only want to auto-apply fees on the
  // transition, not on every subsequent edit (e.g. updating an address on
  // an already-approved student shouldn't re-run the fee logic — though
  // applySchoolWideFees is idempotent and would just skip already-applied
  // fees, we avoid the wasted SQL).
  const priorStatus = req.body.status !== undefined
    ? await studentsService.getStatus(req.params.id)
    : null;

  const student = await studentsService.update(req.params.id, req.body);
  if (!student) throw new HttpError(404, 'Student not found');

  // Only auto-apply on the upward transition (pending/rejected → approved
  // or enrolled). approved → enrolled doesn't need it because approved
  // already got the fees.
  const becameApproved =
    req.body.status !== undefined &&
    (student.status === 'approved' || student.status === 'enrolled') &&
    priorStatus !== 'approved' &&
    priorStatus !== 'enrolled';

  if (becameApproved) {
    try {
      const r = await studentsService.applySchoolWideFees(student.id);
      if (r && r.student) return res.json(r.student);
    } catch (err) {
      console.error(
        '[students.update] auto-fee application failed for',
        student.id, '—', err && err.message
      );
    }
  }

  res.json(student);
});

const remove = asyncHandler(async (req, res) => {
  const ok = await studentsService.remove(req.params.id);
  if (!ok) throw new HttpError(404, 'Student not found');
  res.status(204).end();
});

// ─── Charges ─────────────────────────────────────────────────────────────

const addCharge = asyncHandler(async (req, res) => {
  expect(req.body, {
    title:  { type: 'string', max: 200 },
    amount: 'nonNegativeNumber'
  });
  const result = await studentsService.addCharge(req.params.id, req.body);
  if (!result) throw new HttpError(404, 'Student not found');
  res.status(201).json(result);
});

const applyAutoFees = asyncHandler(async (req, res) => {
  const result = await studentsService.applySchoolWideFees(req.params.id);
  if (!result.student) throw new HttpError(404, 'Student not found');
  res.json(result);
});

const applyOptionalFee = asyncHandler(async (req, res) => {
  expect(req.body, { miscFeeId: 'string' });
  const result = await studentsService.applyMiscFee(req.params.id, req.body.miscFeeId);
  if (!result) throw new HttpError(404, 'Student or fee not found');
  res.json(result);
});

// ─── Subjects ────────────────────────────────────────────────────────────

const assignSubjects = asyncHandler(async (req, res) => {
  expect(req.body, { subjectIds: { type: 'array', min: 1 } });
  const result = await studentsService.assignSubjectsToStudent(
    req.params.id, req.body.subjectIds
  );
  if (!result.student) throw new HttpError(404, 'Student not found');
  res.json(result);
});

// ─── Grade change (correction / promotion) ───────────────────────────────

const changeGrade = asyncHandler(async (req, res) => {
  expect(req.body, {
    newGrade: { type: 'string', max: 40 },
    reason:   { type: 'enum', values: ['correction', 'promotion'] },
    newSchoolYear: { type: 'string', max: 20, optional: true }
  });
  const result = await promotionService.changeStudentGrade(
    req.params.id,
    req.body.newGrade,
    {
      reason: req.body.reason,
      newSchoolYear: req.body.newSchoolYear
    }
  );
  if (!result) throw new HttpError(404, 'Student not found');
  res.json(result);
});

module.exports = {
  list, getOne, create, update, remove,
  addCharge, applyAutoFees, applyOptionalFee,
  assignSubjects, changeGrade
};
