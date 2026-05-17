/**
 * routes.js — central API surface.
 *
 * All routes are mounted under /api in server.js. With one exception
 * (POST /api/auth/signup, POST /api/auth/login), every endpoint is gated
 * by requireAuth(), which decodes the JWT and attaches req.user.
 *
 * Role enforcement here is intentionally light — the original frontend
 * trusted any signed-in user with any of the four roles, and we don't have
 * the requirements to lock things down further. If you ever want
 * "only cashiers can void payments" semantics, drop a role list into the
 * relevant requireAuth([...]) call.
 */
'use strict';

const express = require('express');
const multer  = require('multer');

const { requireAuth } = require('./middleware/auth');

const auth        = require('./controllers/auth.controller');
const bootstrap   = require('./controllers/bootstrap.controller');
const students    = require('./controllers/students.controller');
const payments    = require('./controllers/payments.controller');
const miscFees    = require('./controllers/miscFees.controller');
const activityLog = require('./controllers/activityLog.controller');
const settings    = require('./controllers/settings.controller');
const users       = require('./controllers/users.controller');
const onlineEnroll = require('./controllers/publicEnrollment.controller');
const { sections, subjects, faculty } = require('./controllers/simple.controllers');

const router = express.Router();

// ─── Multipart upload config (Online Enrollment document uploads) ────────
// In-memory storage: files are handed to fileStorage (the swappable disk/S3
// layer) by the service. 8 MB per file is generous for a scanned PDF/photo;
// at most 8 files (one per requirement document) in a single request.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 8 * 1024 * 1024, files: 8 },
  fileFilter(_req, file, cb) {
    const ok = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only PDF or image files are allowed'), ok);
  }
});

// ─── Auth (public) ───────────────────────────────────────────────────────
router.post('/auth/signup', auth.signup);
router.post('/auth/login',  auth.login);
router.get ('/auth/me',     requireAuth(), auth.me);

// ─── Bootstrap (one-shot snapshot for the frontend cache) ────────────────
router.get('/bootstrap', requireAuth(), bootstrap.bootstrap);

// ─── Online Enrollment Module ────────────────────────────────────────────
// PUBLIC (no auth) — the parent-facing enroll.html form.
//   submit:  JSON body → creates a 'pending' student + guardian rows.
//   :id/documents: multipart upload of the requirement files. multer
//   accepts ANY field name; each file's fieldname IS its document type, so
//   .any() is correct here (the service validates the type against a
//   whitelist).
router.post('/online-enrollment/submit', onlineEnroll.submit);
router.post('/online-enrollment/:id/documents',
  upload.any(), onlineEnroll.uploadDocuments);
// Public read: the school-year list + active year, so the public form can
// default its dropdown without needing a login.
router.get('/online-enrollment/school-years', onlineEnroll.schoolYears);

// REGISTRAR (auth) — the "Online Submissions" review queue.
router.get ('/online-enrollment/submissions',
  requireAuth(), onlineEnroll.listSubmissions);
router.get ('/online-enrollment/submissions/:id',
  requireAuth(), onlineEnroll.getSubmission);
router.post('/online-enrollment/submissions/:id/approve',
  requireAuth(), onlineEnroll.approve);
router.post('/online-enrollment/submissions/:id/reject',
  requireAuth(), onlineEnroll.reject);
router.get ('/online-enrollment/documents/:docId/file',
  requireAuth(), onlineEnroll.downloadDocument);

// ─── Students ────────────────────────────────────────────────────────────
router.get   ('/students',        requireAuth(), students.list);
router.post  ('/students',        requireAuth(), students.create);
router.get   ('/students/:id',    requireAuth(), students.getOne);
router.patch ('/students/:id',    requireAuth(), students.update);
router.delete('/students/:id',    requireAuth(), students.remove);

// student-scoped sub-resources
router.post('/students/:id/charges',        requireAuth(), students.addCharge);
router.post('/students/:id/auto-fees',      requireAuth(), students.applyAutoFees);
router.post('/students/:id/optional-fees',  requireAuth(), students.applyOptionalFee);
router.post('/students/:id/subjects',       requireAuth(), students.assignSubjects);
router.post('/students/:id/grade-change',   requireAuth(), students.changeGrade);
router.post('/students/:id/payments',       requireAuth(), payments.record);

// ─── Payments ────────────────────────────────────────────────────────────
router.get ('/payments',          requireAuth(), payments.list);
router.get ('/payments/:id',      requireAuth(), payments.getOne);
router.post('/payments/:id/void', requireAuth(), payments.voidIt);

// ─── Misc fees ───────────────────────────────────────────────────────────
router.get   ('/misc-fees',     requireAuth(), miscFees.list);
router.post  ('/misc-fees',     requireAuth(), miscFees.create);
router.get   ('/misc-fees/:id', requireAuth(), miscFees.getOne);
router.patch ('/misc-fees/:id', requireAuth(), miscFees.update);
router.delete('/misc-fees/:id', requireAuth(), miscFees.remove);

// ─── Sections ────────────────────────────────────────────────────────────
router.get   ('/sections',     requireAuth(), sections.list);
router.post  ('/sections',     requireAuth(), sections.create);
router.get   ('/sections/:id', requireAuth(), sections.getOne);
router.patch ('/sections/:id', requireAuth(), sections.update);
router.delete('/sections/:id', requireAuth(), sections.remove);

// ─── Subjects ────────────────────────────────────────────────────────────
router.get   ('/subjects',     requireAuth(), subjects.list);
router.post  ('/subjects',     requireAuth(), subjects.create);
router.get   ('/subjects/:id', requireAuth(), subjects.getOne);
router.patch ('/subjects/:id', requireAuth(), subjects.update);
router.delete('/subjects/:id', requireAuth(), subjects.remove);

// ─── Faculty ─────────────────────────────────────────────────────────────
router.get   ('/faculty',     requireAuth(), faculty.list);
router.post  ('/faculty',     requireAuth(), faculty.create);
router.get   ('/faculty/:id', requireAuth(), faculty.getOne);
router.patch ('/faculty/:id', requireAuth(), faculty.update);
router.delete('/faculty/:id', requireAuth(), faculty.remove);

// ─── Activity log ────────────────────────────────────────────────────────
router.get ('/activity-log', requireAuth(), activityLog.list);
router.post('/activity-log', requireAuth(), activityLog.append);

// ─── Settings ────────────────────────────────────────────────────────────
router.get('/settings',                   requireAuth(), settings.list);
router.get('/settings/active-school-year',requireAuth(), settings.getActiveSY);
router.put('/settings/active-school-year',requireAuth(), settings.setActiveSY);
router.get('/settings/:key',              requireAuth(), settings.get);
router.put('/settings/:key',              requireAuth(), settings.set);

// ─── Users ───────────────────────────────────────────────────────────────
// /auth/signup is the self-service path (issues a JWT). POST /users is the
// admin-side path (does not issue a JWT — caller already has one).
router.get   ('/users',     requireAuth(), users.list);
router.post  ('/users',     requireAuth(), users.create);
router.get   ('/users/:id', requireAuth(), users.getOne);
router.patch ('/users/:id', requireAuth(), users.update);
router.delete('/users/:id', requireAuth(), users.remove);

// ─── 404 for unknown /api routes ─────────────────────────────────────────
router.use((req, res) => {
  res.status(404).json({ error: `No such API endpoint: ${req.method} ${req.originalUrl}` });
});

module.exports = router;
