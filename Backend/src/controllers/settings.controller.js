/**
 * settings.controller.js — generic key/value settings + the active-SY shortcut.
 *
 * `list` returns the whole map (used by /api/bootstrap and ad-hoc reads),
 * `set` updates one key. Values are JSON-serializable.
 */
'use strict';

const settingsService = require('../services/settingsService');
const { HttpError, asyncHandler } = require('../middleware/errorHandler');
const { expect } = require('../middleware/validate');

const list = asyncHandler(async (_req, res) => {
  res.json(await settingsService.getAll());
});

const get = asyncHandler(async (req, res) => {
  const value = await settingsService.get(req.params.key);
  if (value === null && req.query.required === '1') {
    throw new HttpError(404, `Setting "${req.params.key}" is not set.`);
  }
  res.json({ key: req.params.key, value });
});

const set = asyncHandler(async (req, res) => {
  // The body should always have `value`; the key is in the URL.
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'value')) {
    throw new HttpError(400, 'Body must include "value".');
  }
  // Soft cap on stored value size — the column is TEXT so technically up
  // to 64KB, but we don't want huge blobs sneaking into a settings store.
  const json = JSON.stringify(req.body.value);
  if (json.length > 32_000) {
    throw new HttpError(400, 'Setting value too large (max ~32KB serialized).');
  }
  await settingsService.set(req.params.key, req.body.value);
  res.json({ key: req.params.key, value: req.body.value });
});

const getActiveSY = asyncHandler(async (_req, res) => {
  res.json({ activeSchoolYear: await settingsService.getActiveSchoolYear() });
});

const setActiveSY = asyncHandler(async (req, res) => {
  expect(req.body, { schoolYear: { type: 'string', max: 20 } });
  const sy = await settingsService.setActiveSchoolYear(req.body.schoolYear);
  res.json({ activeSchoolYear: sy });
});

module.exports = { list, get, set, getActiveSY, setActiveSY };
