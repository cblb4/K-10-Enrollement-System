/**
 * bootstrap.controller.js — single endpoint that loads every collection the
 * frontend cache needs for an authenticated session, in one round trip.
 *
 * The frontend's storage.js used to read everything synchronously from
 * localStorage. To preserve that synchronous public API after migrating to
 * a real backend, the frontend now warms a cache from this endpoint at
 * page-load time, then serves all reads from the cache. Writes go to the
 * dedicated REST endpoints.
 *
 * Returning the whole working set in one call is fine here — total payload
 * is small (typical school: hundreds of students, dozens of fees, sub-MB
 * total) and avoids the page having to fan out 8 separate calls before it
 * can render anything.
 */
'use strict';

const studentsService = require('../services/studentsService');
const paymentsService = require('../services/paymentsService');
const miscFeesService = require('../services/miscFeesService');
const settingsService = require('../services/settingsService');
const simple          = require('../services/simpleService');
const { asyncHandler } = require('../middleware/errorHandler');

const bootstrap = asyncHandler(async (req, res) => {
  // Run reads in parallel — they're all independent.
  const [
    students,
    payments,
    sections,
    subjects,
    faculty,
    miscFees,
    activityLog,
    users,
    settings
  ] = await Promise.all([
    studentsService.getAll(),
    paymentsService.getAll(),
    simple.sections.getAll(),
    simple.subjects.getAll(),
    simple.faculty.getAll(),
    miscFeesService.getAll(),
    simple.activity.getAll(1000),
    simple.users.getAll(),
    settingsService.getAll()
  ]);

  res.json({
    students,
    payments,
    sections,
    subjects,
    faculty,
    miscFees,
    activityLog,
    users,
    settings
  });
});

module.exports = { bootstrap };
