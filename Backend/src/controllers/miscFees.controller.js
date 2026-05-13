/**
 * miscFees.controller.js — CRUD for the misc-fee catalog.
 *
 * The interesting bit is `update`, which the service uses to forward-apply
 * any newly-matching auto-apply fee to existing students. The frontend
 * uses the resulting retroAppliedToStudentIds[] to refresh its per-student
 * caches.
 */
'use strict';

const miscFeesService = require('../services/miscFeesService');
const settingsService = require('../services/settingsService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect, FEE_SCOPES } = require('../middleware/validate');

const list = asyncHandler(async (_req, res) => {
  res.json(await miscFeesService.getAll());
});

const getOne = asyncHandler(async (req, res) => {
  const fee = await miscFeesService.getById(req.params.id);
  if (!fee) throw new HttpError(404, 'Fee not found');
  res.json(fee);
});

const create = asyncHandler(async (req, res) => {
  expect(req.body, {
    name:        { type: 'string', max: 200 },
    amount:      'nonNegativeNumber',
    scope:       { type: 'enum', values: FEE_SCOPES },
    schoolYear:  { type: 'string', max: 20, optional: true },
    gradeLevels: { type: 'array', optional: true }
  });

  // If scope='grades', require non-empty grade list. (The service won't
  // misbehave without it — fees just wouldn't match anyone — but it's
  // almost certainly a UI bug, so reject early.)
  if (req.body.scope === 'grades') {
    if (!Array.isArray(req.body.gradeLevels) || req.body.gradeLevels.length === 0) {
      throw new HttpError(400, 'gradeLevels[] is required when scope="grades".');
    }
  }

  // Default school year if omitted.
  const schoolYear = req.body.schoolYear
    || await settingsService.getActiveSchoolYear();

  const fee = await miscFeesService.create({ ...req.body, schoolYear });
  res.status(201).json(fee);
});

const update = asyncHandler(async (req, res) => {
  // For PATCH-style updates, every field is optional, but if scope is being
  // changed to 'grades' we still want gradeLevels to be present.
  if (req.body.scope !== undefined) {
    expect(req.body, { scope: { type: 'enum', values: FEE_SCOPES } });
    if (req.body.scope === 'grades' && !Array.isArray(req.body.gradeLevels)) {
      throw new HttpError(400, 'gradeLevels[] is required when scope="grades".');
    }
  }
  if (req.body.amount !== undefined) {
    expect(req.body, { amount: 'nonNegativeNumber' });
  }

  const result = await miscFeesService.update(req.params.id, req.body);
  if (!result) throw new HttpError(404, 'Fee not found');
  res.json(result);
});

const remove = asyncHandler(async (req, res) => {
  const ok = await miscFeesService.remove(req.params.id);
  if (!ok) throw new HttpError(404, 'Fee not found');
  res.status(204).end();
});

module.exports = { list, getOne, create, update, remove };
