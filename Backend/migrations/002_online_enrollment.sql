-- ==========================================================================
-- Heartworks Learning Center — Enrollment System
-- Migration 002 — Online Enrollment Module
-- ==========================================================================
-- COMPATIBILITY VERSION — works on MySQL 5.7, MySQL 8.0, and MariaDB.
--
-- This version removes the "IF NOT EXISTS" clauses that only MySQL 8.0.13+
-- supports. As a result it must be run EXACTLY ONCE — re-running it will
-- error because the columns/tables already exist. The migration runner
-- (npm run migrate) records applied migrations, so it will not re-run this
-- on its own.
--
-- Adds support for the public online enrollment form:
--   1. Extra one-to-one learner / enrollment columns on `students`
--   2. `student_guardians`     — father, mother, emergency contact
--   3. `enrollment_documents`  — the 8 uploadable requirement files
-- ==========================================================================

USE hlc_enrollment;

-- --------------------------------------------------------------------------
-- 1. STUDENTS — extend with learner + enrollment-meta fields.
--
-- All strictly one-to-one with a student, so flat columns are correct.
-- `age` is intentionally NOT stored — it is derived from birth_date on read.
-- --------------------------------------------------------------------------
ALTER TABLE students
  ADD COLUMN enrollment_source    ENUM('walk-in','online') NOT NULL DEFAULT 'walk-in',
  ADD COLUMN program              VARCHAR(120) NULL,
  ADD COLUMN school_last_attended VARCHAR(200) NULL,
  ADD COLUMN enrollment_date      DATE         NULL,
  ADD COLUMN shuttle_service      TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN carpool_service      VARCHAR(200) NULL,
  ADD COLUMN one_way_service      VARCHAR(40)  NULL,
  ADD COLUMN esc_grantee          TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN submitted_at         DATETIME     NULL,
  ADD COLUMN reviewed_at          DATETIME     NULL,
  ADD COLUMN reviewed_by          VARCHAR(100) NULL,
  ADD COLUMN rejection_reason     TEXT         NULL,
  ADD KEY ix_students_source (enrollment_source, status);

-- The online form does not collect a single "guardianName" / "contact" /
-- "address" the way the walk-in form does. Those columns are NOT NULL in
-- migration 001, so online submissions would fail to insert. Relax them to
-- NULL-able; the service layer back-fills them from the father/mother rows
-- for backward compatibility with existing registrar UI code.
ALTER TABLE students
  MODIFY COLUMN guardian_name VARCHAR(200) NULL,
  MODIFY COLUMN contact       VARCHAR(50)  NULL,
  MODIFY COLUMN address       TEXT         NULL;

-- --------------------------------------------------------------------------
-- 2. STUDENT_GUARDIANS — father / mother / emergency contact.
--
-- Father, mother and emergency contact are structurally identical (name
-- parts + address + phone). One typed table avoids ~21 repeated columns on
-- `students` and lets a school add another contact later with no migration.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_guardians (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  student_id      VARCHAR(64)  NOT NULL,
  guardian_type   ENUM('father','mother','emergency') NOT NULL,
  last_name       VARCHAR(100) NULL,
  first_name      VARCHAR(100) NULL,
  middle_name     VARCHAR(100) NULL,
  full_name       VARCHAR(200) NULL,
  relationship    VARCHAR(100) NULL,
  home_address    TEXT         NULL,
  religion        VARCHAR(100) NULL,
  mobile_number   VARCHAR(50)  NULL,
  telephone_number VARCHAR(50) NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_guardians_student
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  UNIQUE KEY uq_guardian_per_student (student_id, guardian_type),
  KEY ix_guardians_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- 3. ENROLLMENT_DOCUMENTS — the 8 uploadable requirement files.
--
-- One row per uploaded file, typed by `document_type`. Files themselves live
-- on disk (Backend/uploads/); only the relative path + metadata are stored
-- here, which keeps the database backup small.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollment_documents (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  student_id      VARCHAR(64)  NOT NULL,
  document_type   ENUM(
                    'affidavit_of_undertaking',
                    'report_card',
                    'good_moral',
                    'psa_birth_certificate',
                    'doctors_advice',
                    'sbt_result',
                    'flu_vaccine_certificate',
                    'valid_id'
                  ) NOT NULL,
  original_name   VARCHAR(255) NOT NULL,
  stored_path     VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(100) NOT NULL,
  size_bytes      INT          NOT NULL,
  uploaded_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_documents_student
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  UNIQUE KEY uq_document_per_student (student_id, document_type),
  KEY ix_documents_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
