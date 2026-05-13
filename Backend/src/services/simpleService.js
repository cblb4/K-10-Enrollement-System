/**
 * simpleService.js — straightforward CRUD for the five collections that
 * don't have any cross-table business logic: sections, subjects, faculty,
 * activity_log, users.
 *
 * Each one exposes: getAll, getById, create, update (where allowed), remove.
 * Activity log is append-only by design — it's an audit trail, so no update
 * or remove path exists for it.
 *
 * Users have full CRUD here. The auth.controller still owns sign-up
 * (because that flow also issues a JWT); this module's `users.create` is
 * the admin-side creation path that just inserts a row.
 *
 * Validation/auth happens in the controllers; this layer is purely DB access
 * with row-mapping to the camelCase shapes the frontend expects.
 */
'use strict';

const bcrypt = require('bcryptjs');

const db = require('../db');
const {
  generateId,
  rowToSection, rowToSubject, rowToFaculty, rowToActivity, rowToUser
} = require('../util');

const BCRYPT_COST = 12;

// Generic "build SET clause from a column whitelist" helper. Returns
// { fragments: ['col = ?', ...], values: [...] } so callers can splice it
// straight into an UPDATE. If the patch carried no recognized fields the
// arrays come back empty and the caller can short-circuit.
function buildPatch(patch, fieldMap) {
  const fragments = [];
  const values = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!fieldMap[k]) continue;
    fragments.push(`${fieldMap[k]} = ?`);
    values.push(v === '' ? null : v);
  }
  return { fragments, values };
}

// ─── Sections ────────────────────────────────────────────────────────────
const SECTION_FIELDS = {
  name:       'name',
  gradeLevel: 'grade_level',
  adviser:    'adviser',
  capacity:   'capacity'
};

const sections = {
  async getAll() {
    const rows = await db.query('SELECT * FROM sections ORDER BY created_at DESC');
    return rows.map(rowToSection);
  },
  async getById(id) {
    return rowToSection(await db.queryOne('SELECT * FROM sections WHERE id = ?', [id]));
  },
  async create(input) {
    const id = input.id || generateId('sec');
    await db.query(
      `INSERT INTO sections (id, name, grade_level, adviser, capacity)
         VALUES (?, ?, ?, ?, ?)`,
      [id, input.name, input.gradeLevel, input.adviser, input.capacity | 0]
    );
    return this.getById(id);
  },
  async update(id, patch) {
    const existing = await db.queryOne('SELECT id FROM sections WHERE id = ?', [id]);
    if (!existing) return null;

    // capacity is stored as INT — coerce explicitly so '35' becomes 35
    // (the form may submit a string).
    const cleaned = { ...patch };
    if (cleaned.capacity !== undefined) cleaned.capacity = cleaned.capacity | 0;

    const { fragments, values } = buildPatch(cleaned, SECTION_FIELDS);
    if (!fragments.length) return this.getById(id);

    values.push(id);
    await db.query(
      `UPDATE sections SET ${fragments.join(', ')} WHERE id = ?`,
      values
    );
    return this.getById(id);
  },
  async remove(id) {
    const [r] = await db.pool.execute('DELETE FROM sections WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }
};

// ─── Subjects ────────────────────────────────────────────────────────────
const SUBJECT_FIELDS = {
  name:        'name',
  gradeLevel:  'grade_level',
  fee:         'fee',
  description: 'description'
};

const subjects = {
  async getAll() {
    const rows = await db.query(
      'SELECT * FROM subjects ORDER BY grade_level ASC, name ASC'
    );
    return rows.map(rowToSubject);
  },
  async getById(id) {
    return rowToSubject(await db.queryOne('SELECT * FROM subjects WHERE id = ?', [id]));
  },
  async create(input) {
    const id = input.id || generateId('sub');
    await db.query(
      `INSERT INTO subjects (id, name, grade_level, fee, description)
         VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.gradeLevel,
        Number(input.fee) || 0,
        input.description || null
      ]
    );
    return this.getById(id);
  },
  async update(id, patch) {
    const existing = await db.queryOne('SELECT id FROM subjects WHERE id = ?', [id]);
    if (!existing) return null;

    const cleaned = { ...patch };
    if (cleaned.fee !== undefined) cleaned.fee = Number(cleaned.fee) || 0;

    const { fragments, values } = buildPatch(cleaned, SUBJECT_FIELDS);
    if (!fragments.length) return this.getById(id);

    values.push(id);
    await db.query(
      `UPDATE subjects SET ${fragments.join(', ')} WHERE id = ?`,
      values
    );
    return this.getById(id);
  },
  async remove(id) {
    // Existing assignments (charges with source='subject', subject_id=this)
    // are kept — the subject is dropped from catalog only. Frontend's
    // deleteSubject() comment says exactly this.
    const [r] = await db.pool.execute('DELETE FROM subjects WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }
};

// ─── Faculty ─────────────────────────────────────────────────────────────
const FACULTY_FIELDS = {
  firstName:    'first_name',
  lastName:     'last_name',
  position:     'position',
  department:   'department',
  email:        'email',
  contact:      'contact',
  photoDataUrl: 'photo_data_url'
};

const faculty = {
  async getAll() {
    const rows = await db.query('SELECT * FROM faculty ORDER BY created_at DESC');
    return rows.map(rowToFaculty);
  },
  async getById(id) {
    return rowToFaculty(await db.queryOne('SELECT * FROM faculty WHERE id = ?', [id]));
  },
  async create(input) {
    const id = input.id || generateId('fac');
    await db.query(
      `INSERT INTO faculty (
          id, first_name, last_name, position, department, email, contact, photo_data_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.firstName, input.lastName,
        input.position,  input.department,
        input.email,     input.contact,
        input.photoDataUrl || null
      ]
    );
    return this.getById(id);
  },
  async update(id, patch) {
    const existing = await db.queryOne('SELECT id FROM faculty WHERE id = ?', [id]);
    if (!existing) return null;

    const { fragments, values } = buildPatch(patch, FACULTY_FIELDS);
    if (!fragments.length) return this.getById(id);

    values.push(id);
    await db.query(
      `UPDATE faculty SET ${fragments.join(', ')} WHERE id = ?`,
      values
    );
    return this.getById(id);
  },
  async remove(id) {
    const [r] = await db.pool.execute('DELETE FROM faculty WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }
};

// ─── Activity log ────────────────────────────────────────────────────────
// Append-only — no remove, no update. Anyone can read; only authed users
// can append (enforced at the route level).
const activity = {
  async getAll(limit) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
    const rows = await db.query(
      `SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ${cap}`
    );
    return rows.map(rowToActivity);
  },
  async append({ role, action, details }) {
    const id = generateId('log');
    await db.query(
      `INSERT INTO activity_log (id, role, action, details) VALUES (?, ?, ?, ?)`,
      [id, role || null, action, details || null]
    );
    return rowToActivity(await db.queryOne(
      'SELECT * FROM activity_log WHERE id = ?', [id]
    ));
  }
};

// ─── Users ───────────────────────────────────────────────────────────────
// Read methods serve the directory. Write methods (create/update/remove)
// power admin-side user management; sign-up still has its own dedicated
// endpoint in auth.controller.js (which sets a JWT on the response).
//
// Patchable user columns. We deliberately do NOT expose `id` or `created_at`
// to PATCH callers, and `password` is handled separately so it can be
// hashed before hitting the DB.
const USER_FIELDS = {
  fullName: 'full_name',
  email:    'email',
  role:     'role'
};

const users = {
  async getAll() {
    const rows = await db.query(
      'SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC'
    );
    return rows.map(rowToUser);
  },
  async getById(id) {
    const row = await db.queryOne(
      'SELECT id, full_name, email, role, created_at FROM users WHERE id = ?',
      [id]
    );
    return rowToUser(row);
  },
  /**
   * Admin-side user creation. Mirrors auth.signup but doesn't issue a JWT —
   * the caller is an already-authenticated admin creating an account for
   * someone else. Throws { status: 409, ... } on duplicate email so the
   * controller can map it to a friendly response.
   */
  async create(input) {
    const fullName = String(input.fullName || '').trim();
    const email    = String(input.email    || '').trim().toLowerCase();
    const password = String(input.password || '');
    const role     = input.role;

    const existing = await db.queryOne(
      'SELECT id FROM users WHERE email = ?', [email]
    );
    if (existing) {
      const e = new Error('An account with that email already exists.');
      e.status = 409;
      throw e;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const id = input.id || generateId('usr');

    await db.query(
      `INSERT INTO users (id, full_name, email, password_hash, role)
         VALUES (?, ?, ?, ?, ?)`,
      [id, fullName, email, passwordHash, role]
    );
    return this.getById(id);
  },
  /**
   * Patch an existing user. Any subset of {fullName, email, role, password}
   * may be provided. Email uniqueness is re-checked when it changes.
   */
  async update(id, patch) {
    const existing = await db.queryOne(
      'SELECT id, email FROM users WHERE id = ?', [id]
    );
    if (!existing) return null;

    const cleaned = { ...patch };
    if (typeof cleaned.fullName === 'string') cleaned.fullName = cleaned.fullName.trim();
    if (typeof cleaned.email === 'string')    cleaned.email    = cleaned.email.trim().toLowerCase();

    // If email is changing, ensure it's still unique.
    if (cleaned.email && cleaned.email !== existing.email) {
      const dup = await db.queryOne(
        'SELECT id FROM users WHERE email = ? AND id <> ?',
        [cleaned.email, id]
      );
      if (dup) {
        const e = new Error('Another account already uses that email.');
        e.status = 409;
        throw e;
      }
    }

    const { fragments, values } = buildPatch(cleaned, USER_FIELDS);

    // Password is handled separately so we can bcrypt it.
    if (typeof patch.password === 'string' && patch.password.length > 0) {
      const passwordHash = await bcrypt.hash(patch.password, BCRYPT_COST);
      fragments.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (!fragments.length) return this.getById(id);

    values.push(id);
    await db.query(
      `UPDATE users SET ${fragments.join(', ')} WHERE id = ?`,
      values
    );
    return this.getById(id);
  },
  async remove(id) {
    const [r] = await db.pool.execute('DELETE FROM users WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }
};

module.exports = { sections, subjects, faculty, activity, users };
