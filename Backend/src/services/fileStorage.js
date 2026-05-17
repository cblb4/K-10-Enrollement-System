/**
 * fileStorage.js — swappable file-storage abstraction.
 *
 * The Online Enrollment Module needs to persist uploaded requirement files
 * (birth certificates, report cards, parent IDs, ...). WHERE those bytes
 * live is a deployment decision, not an application decision — so every
 * other module in this codebase touches files ONLY through the functions
 * exported here:
 *
 *     save(file)            → { storedPath }   persist one uploaded file
 *     remove(storedPath)    → void             delete a saved file
 *     absolutePathFor(path) → string           on-disk path for serving
 *
 * `storedPath` is an opaque, relative string. The caller stores it in
 * enrollment_documents.stored_path and never interprets it.
 *
 * ── Swapping backends ────────────────────────────────────────────────────
 * To move to AWS S3 / Cloudflare R2 / MinIO later, replace ONLY the body
 * of this file with an implementation that uploads via @aws-sdk/client-s3
 * and returns the object key as `storedPath`. The controller, the service,
 * the database schema and the frontend form do not change. The one place
 * that also needs attention is how documents are *served* back to the
 * registrar — an S3 version would expose an async `signedUrlFor()` that
 * returns a short-lived pre-signed URL instead of `absolutePathFor()`.
 *
 * Current implementation: LOCAL DISK. Files are written under
 * Backend/uploads/, which should be a persistent volume in production.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// Backend/uploads/ — resolved relative to this file (src/services → ../../).
const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'uploads');

// Ensure the directory exists at startup so the first upload doesn't race.
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/**
 * Persist one uploaded file.
 *
 * @param {object} file — a multer file object. With multer.memoryStorage()
 *                        it carries { buffer, originalname, mimetype, size }.
 * @returns {Promise<{storedPath: string}>} relative path for the DB.
 */
async function save(file) {
  if (!file || !file.buffer) {
    throw new Error('fileStorage.save: expected an in-memory multer file');
  }
  // A collision-resistant name; keep the original extension for clarity.
  const ext = path.extname(file.originalname || '').slice(0, 12);
  const name = crypto.randomBytes(16).toString('hex') + ext;

  // Shard into yyyy-mm subfolders so one directory never holds 100k files.
  const now = new Date();
  const subdir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const destDir = path.join(UPLOAD_ROOT, subdir);
  fs.mkdirSync(destDir, { recursive: true });

  const absPath = path.join(destDir, name);
  await fs.promises.writeFile(absPath, file.buffer);

  // Relative path (POSIX separators) — this is what goes in the DB.
  return { storedPath: `${subdir}/${name}` };
}

/**
 * Delete a previously-saved file. Missing files are ignored (idempotent) —
 * useful when a re-upload replaces a row whose file was already cleaned up.
 *
 * @param {string} storedPath — the value returned by save().
 */
async function remove(storedPath) {
  if (!storedPath) return;
  // Guard against path traversal — storedPath must stay inside UPLOAD_ROOT.
  const absPath = path.resolve(UPLOAD_ROOT, storedPath);
  if (!absPath.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error('fileStorage.remove: refusing path outside upload root');
  }
  try {
    await fs.promises.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;   // ignore "already gone"
  }
}

/**
 * The absolute on-disk path for a stored file. Used by the authenticated
 * document-download route in routes.js.
 */
function absolutePathFor(storedPath) {
  const absPath = path.resolve(UPLOAD_ROOT, storedPath);
  if (!absPath.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error('fileStorage.absolutePathFor: path outside upload root');
  }
  return absPath;
}

module.exports = {
  UPLOAD_ROOT,
  save,
  remove,
  absolutePathFor
};
