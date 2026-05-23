-- ==========================================================================
-- Heartworks Learning Center — Enrollment System
-- Migration 004 — Physical Document Receipts
-- ==========================================================================
-- Some parents drop requirement documents off at the registrar's desk in
-- person instead of uploading them through the online form. Today there's
-- no way to record that, so the approval gate (which checks for uploaded
-- rows) blocks legitimate enrollees whose paperwork is sitting on the
-- desk in physical form.
--
-- This migration extends `enrollment_documents` so a row can represent a
-- *physical* receipt with no file attached. The unique (student_id,
-- document_type) key is kept — still one row per doc per student, just
-- with two possible flavors:
--
--   - received_method = 'uploaded' → file fields are populated (existing
--     behavior; this is the implicit default for all pre-migration rows).
--   - received_method = 'physical' → file fields are NULL; received_by /
--     received_at carry who logged the paper and when.
--
-- A physical row can later be "upgraded" to digital by uploading a scan —
-- the existing UPSERT in attachDocuments() fills the file fields and
-- flips received_method back to 'uploaded'.
--
-- The approval-gate query in studentsService.missingRequiredDocuments()
-- just checks for row presence, so it automatically counts both methods
-- without code changes (we add tightening on the service layer separately).
--
-- Compatible with MySQL 5.7+, MySQL 8.0, MariaDB 10.x.
-- ==========================================================================

USE hlc_enrollment;

-- Step 1 — relax the file-related columns so physical rows can have NULLs.
-- (These columns are required for uploaded docs and remain enforced at
--  the application layer; the DB just allows NULL so a physical row can
--  legitimately omit them.)
ALTER TABLE enrollment_documents
  MODIFY COLUMN original_name VARCHAR(255) NULL,
  MODIFY COLUMN stored_path   VARCHAR(255) NULL,
  MODIFY COLUMN mime_type     VARCHAR(100) NULL,
  MODIFY COLUMN size_bytes    INT          NULL;

-- Step 2 — add the new tracking columns.
-- received_method tells the application which "flavor" of row this is.
-- Pre-existing rows default to 'uploaded', which matches their content.
ALTER TABLE enrollment_documents
  ADD COLUMN received_method
       ENUM('uploaded','physical') NOT NULL DEFAULT 'uploaded'
       AFTER size_bytes,
  ADD COLUMN received_by VARCHAR(200) NULL AFTER received_method,
  ADD COLUMN received_at DATETIME     NULL AFTER received_by;
