/**
 * validate — small, dependency-free input validation helpers.
 *
 * The pattern: each route's controller calls `expect()` for required fields
 * and the typed coercers for optional ones. On failure, throws HttpError(400)
 * with a `details` object listing every problem.
 *
 * For complex schemas this would be express-validator or zod; for an app of
 * this scope, a few helpers keep things explicit and fast.
 */
'use strict';

const { HttpError } = require('./errorHandler');

const ROLES         = ['registrar', 'cashier', 'admin', 'principal'];
const STUDENT_STATUSES = ['pending', 'approved', 'rejected', 'enrolled'];
const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'];
const FEE_SCOPES    = ['school', 'grades', 'optional'];
const PAYMENT_MODES = ['full', 'installment_2', 'installment_3'];
const CHARGE_SOURCES = ['manual', 'subject', 'misc-fee', 'discount'];

function isString(v)    { return typeof v === 'string' && v.trim().length > 0; }
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Throw HttpError(400, 'Validation failed', {<field>: <reason>}) if any
 * problems are found. `spec` is { field: validatorFn | 'string' | 'number' | 'enum:[...]' | { type, ...opts } }.
 */
function expect(body, spec) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'Request body is required');
  }
  const details = {};

  for (const [field, rule] of Object.entries(spec)) {
    const v = body[field];
    const reason = checkRule(v, rule);
    if (reason) details[field] = reason;
  }

  if (Object.keys(details).length) {
    throw new HttpError(400, 'Validation failed', details);
  }
}

function checkRule(v, rule) {
  // Function rule: returns string (problem) or null (ok).
  if (typeof rule === 'function') return rule(v);

  // Object rule: { type, optional, max, min, oneOf }
  if (rule && typeof rule === 'object') {
    if (rule.optional && (v === undefined || v === null || v === '')) return null;
    return checkTyped(v, rule);
  }

  // String shorthand
  if (typeof rule === 'string') {
    if (rule === 'string') return isString(v) ? null : 'must be a non-empty string';
    if (rule === 'number') return isFiniteNum(v) ? null : 'must be a number';
    if (rule === 'string?') return v === undefined || v === null || typeof v === 'string' ? null : 'must be a string';
    if (rule === 'positiveNumber') return isFiniteNum(v) && v > 0 ? null : 'must be a positive number';
    if (rule === 'nonNegativeNumber') return isFiniteNum(v) && v >= 0 ? null : 'must be ≥ 0';
    if (rule === 'array') return Array.isArray(v) ? null : 'must be an array';
    if (rule === 'email') return isString(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'must be a valid email address';
  }
  return 'unknown validation rule';
}

function checkTyped(v, rule) {
  if (rule.type === 'string') {
    if (!isString(v)) return 'must be a non-empty string';
    if (rule.max && v.length > rule.max) return `must be at most ${rule.max} characters`;
    if (rule.min && v.length < rule.min) return `must be at least ${rule.min} characters`;
    return null;
  }
  if (rule.type === 'number') {
    if (!isFiniteNum(v)) return 'must be a number';
    if (rule.min !== undefined && v < rule.min) return `must be ≥ ${rule.min}`;
    if (rule.max !== undefined && v > rule.max) return `must be ≤ ${rule.max}`;
    return null;
  }
  if (rule.type === 'enum') {
    if (!rule.values.includes(v)) return `must be one of: ${rule.values.join(', ')}`;
    return null;
  }
  if (rule.type === 'array') {
    if (!Array.isArray(v)) return 'must be an array';
    if (rule.min !== undefined && v.length < rule.min) return `must have at least ${rule.min} items`;
    return null;
  }
  return null;
}

module.exports = {
  expect,
  isString,
  isFiniteNum,
  ROLES,
  STUDENT_STATUSES,
  PAYMENT_STATUSES,
  FEE_SCOPES,
  PAYMENT_MODES,
  CHARGE_SOURCES
};
