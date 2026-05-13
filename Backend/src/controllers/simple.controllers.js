/**
 * simple.controllers.js — thin CRUD controllers for sections, subjects,
 * faculty. They share a tiny shape so we keep them together rather than
 * spreading near-identical files across the directory.
 *
 * Each one supports list / getOne / create / update (PATCH) / remove. The
 * update handlers are PATCH-style: every field is optional, but if provided
 * we still typecheck it (so a malformed value can't slip through to the
 * service layer).
 */
'use strict';

const simple = require('../services/simpleService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect } = require('../middleware/validate');

// ─── Sections ────────────────────────────────────────────────────────────
const sections = {
  list: asyncHandler(async (_req, res) => res.json(await simple.sections.getAll())),

  getOne: asyncHandler(async (req, res) => {
    const row = await simple.sections.getById(req.params.id);
    if (!row) throw new HttpError(404, 'Section not found');
    res.json(row);
  }),

  create: asyncHandler(async (req, res) => {
    expect(req.body, {
      name:       { type: 'string', max: 100 },
      gradeLevel: { type: 'string', max: 40 },
      adviser:    { type: 'string', max: 200 },
      capacity:   { type: 'number', min: 0 }
    });
    res.status(201).json(await simple.sections.create(req.body));
  }),

  update: asyncHandler(async (req, res) => {
    // PATCH-style: every field is optional, but if a field IS provided we
    // still want to typecheck it so a malformed value can't slip through.
    const spec = {};
    if (req.body.name       !== undefined) spec.name       = { type: 'string', max: 100 };
    if (req.body.gradeLevel !== undefined) spec.gradeLevel = { type: 'string', max: 40 };
    if (req.body.adviser    !== undefined) spec.adviser    = { type: 'string', max: 200 };
    if (req.body.capacity   !== undefined) spec.capacity   = { type: 'number', min: 0 };
    if (Object.keys(spec).length) expect(req.body, spec);

    const row = await simple.sections.update(req.params.id, req.body);
    if (!row) throw new HttpError(404, 'Section not found');
    res.json(row);
  }),

  remove: asyncHandler(async (req, res) => {
    const ok = await simple.sections.remove(req.params.id);
    if (!ok) throw new HttpError(404, 'Section not found');
    res.status(204).end();
  })
};

// ─── Subjects ────────────────────────────────────────────────────────────
const subjects = {
  list: asyncHandler(async (_req, res) => res.json(await simple.subjects.getAll())),

  getOne: asyncHandler(async (req, res) => {
    const row = await simple.subjects.getById(req.params.id);
    if (!row) throw new HttpError(404, 'Subject not found');
    res.json(row);
  }),

  create: asyncHandler(async (req, res) => {
    expect(req.body, {
      name:       { type: 'string', max: 200 },
      gradeLevel: { type: 'string', max: 40 },
      // Subject fees default to 0 in the DB; allow either omitted or 0.
      fee:        { type: 'number', min: 0, optional: true }
    });
    res.status(201).json(await simple.subjects.create(req.body));
  }),

  update: asyncHandler(async (req, res) => {
    const spec = {};
    if (req.body.name       !== undefined) spec.name       = { type: 'string', max: 200 };
    if (req.body.gradeLevel !== undefined) spec.gradeLevel = { type: 'string', max: 40 };
    if (req.body.fee        !== undefined) spec.fee        = { type: 'number', min: 0 };
    if (Object.keys(spec).length) expect(req.body, spec);

    const row = await simple.subjects.update(req.params.id, req.body);
    if (!row) throw new HttpError(404, 'Subject not found');
    res.json(row);
  }),

  remove: asyncHandler(async (req, res) => {
    const ok = await simple.subjects.remove(req.params.id);
    if (!ok) throw new HttpError(404, 'Subject not found');
    res.status(204).end();
  })
};

// ─── Faculty ─────────────────────────────────────────────────────────────
const faculty = {
  list: asyncHandler(async (_req, res) => res.json(await simple.faculty.getAll())),

  getOne: asyncHandler(async (req, res) => {
    const row = await simple.faculty.getById(req.params.id);
    if (!row) throw new HttpError(404, 'Faculty not found');
    res.json(row);
  }),

  create: asyncHandler(async (req, res) => {
    expect(req.body, {
      firstName:  { type: 'string', max: 100 },
      lastName:   { type: 'string', max: 100 },
      position:   { type: 'string', max: 100 },
      department: { type: 'string', max: 100 },
      email:      'email',
      contact:    { type: 'string', max: 50 }
      // photoDataUrl is large + optional, no validation beyond the body
      // size limit (set in server.js).
    });
    res.status(201).json(await simple.faculty.create(req.body));
  }),

  update: asyncHandler(async (req, res) => {
    const spec = {};
    if (req.body.firstName  !== undefined) spec.firstName  = { type: 'string', max: 100 };
    if (req.body.lastName   !== undefined) spec.lastName   = { type: 'string', max: 100 };
    if (req.body.position   !== undefined) spec.position   = { type: 'string', max: 100 };
    if (req.body.department !== undefined) spec.department = { type: 'string', max: 100 };
    if (req.body.email      !== undefined) spec.email      = 'email';
    if (req.body.contact    !== undefined) spec.contact    = { type: 'string', max: 50 };
    if (Object.keys(spec).length) expect(req.body, spec);

    const row = await simple.faculty.update(req.params.id, req.body);
    if (!row) throw new HttpError(404, 'Faculty not found');
    res.json(row);
  }),

  remove: asyncHandler(async (req, res) => {
    const ok = await simple.faculty.remove(req.params.id);
    if (!ok) throw new HttpError(404, 'Faculty not found');
    res.status(204).end();
  })
};

module.exports = { sections, subjects, faculty };
