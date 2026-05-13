-- ==========================================================================
-- Heartworks Learning Center — Enrollment System
-- Initial schema (migration 001)
-- ==========================================================================
-- Run with:    mysql -u <user> -p <database> < migrations/001_init.sql
-- Or via the migrate script:    npm run migrate
-- ==========================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------------------------
-- USERS  (auth)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  full_name       VARCHAR(200) NOT NULL,
  email           VARCHAR(200) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            ENUM('registrar','cashier','admin','principal') NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- APP_SETTINGS  (key/value config — e.g. activeSchoolYear, knownSchoolYears)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key     VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value   TEXT         NULL,        -- JSON-encoded
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- SECTIONS  (homerooms / advisory groups owned by Admin)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  grade_level     VARCHAR(40)  NOT NULL,
  adviser         VARCHAR(200) NOT NULL,
  capacity        INT          NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_section_per_grade (name, grade_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- FACULTY  (teachers / staff)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faculty (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  position        VARCHAR(100) NOT NULL,
  department      VARCHAR(100) NOT NULL,
  email           VARCHAR(200) NOT NULL,
  contact         VARCHAR(50)  NOT NULL,
  photo_data_url  MEDIUMTEXT   NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- SUBJECTS  (curriculum catalog, per grade)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subjects (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  grade_level     VARCHAR(40)  NOT NULL,
  fee             DECIMAL(10,2) NOT NULL DEFAULT 0,
  description     TEXT         NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subject_per_grade (name, grade_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- STUDENTS
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  middle_name     VARCHAR(100) NULL,
  birth_date      DATE         NULL,
  gender          VARCHAR(20)  NULL,
  grade_level     VARCHAR(40)  NOT NULL,
  guardian_name   VARCHAR(200) NOT NULL,
  contact         VARCHAR(50)  NOT NULL,
  address         TEXT         NOT NULL,
  notes           TEXT         NULL,
  status          ENUM('pending','approved','rejected','enrolled') NOT NULL DEFAULT 'pending',
  payment_status  ENUM('unpaid','partial','paid')                  NOT NULL DEFAULT 'unpaid',
  payment_mode    VARCHAR(40)  NOT NULL DEFAULT 'full',
  section_id      VARCHAR(64)  NULL,
  school_year     VARCHAR(20)  NOT NULL,
  -- Enrollment-time discount (sibling, scholarship, etc.) — stored as either
  -- a fixed amount or a percentage. NULL means no discount.
  discount_label   VARCHAR(200)  NULL,
  discount_amount  DECIMAL(10,2) NULL,
  discount_percent DECIMAL(5,2)  NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_students_section
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL,
  KEY ix_students_grade (grade_level),
  KEY ix_students_school_year (school_year),
  KEY ix_students_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- MISC_FEES  (catalog of school-wide / grade-targeted / optional fees)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS misc_fees (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  category        VARCHAR(100) NULL,
  scope           ENUM('school','grades','optional') NOT NULL,
  auto_apply      TINYINT(1)   NOT NULL DEFAULT 0,
  description     TEXT         NULL,
  school_year     VARCHAR(20)  NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_misc_fees_scope (scope),
  KEY ix_misc_fees_school_year (school_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- For 'grades'-scoped misc fees: which grade levels they apply to.
CREATE TABLE IF NOT EXISTS misc_fee_grades (
  misc_fee_id     VARCHAR(64)  NOT NULL,
  grade_level     VARCHAR(40)  NOT NULL,
  PRIMARY KEY (misc_fee_id, grade_level),
  CONSTRAINT fk_mfg_fee
    FOREIGN KEY (misc_fee_id) REFERENCES misc_fees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- CHARGES  (line items on a student's account — subjects, fees, manual,
--          discount entries; archived rows are kept here with is_archived=1)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS charges (
  charge_id       VARCHAR(64)  NOT NULL PRIMARY KEY,
  student_id      VARCHAR(64)  NOT NULL,
  title           VARCHAR(200) NOT NULL,
  amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
  description     TEXT         NULL,
  source          ENUM('manual','subject','misc-fee','discount') NOT NULL,
  subject_id      VARCHAR(64)  NULL,
  misc_fee_id     VARCHAR(64)  NULL,
  fee_scope       VARCHAR(20)  NULL,    -- 'school' | 'grades' | 'optional'
  category        VARCHAR(100) NULL,
  school_year     VARCHAR(20)  NULL,
  status          ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid',
  -- For 'discount' source charges, the payment they were attached to.
  payment_id      VARCHAR(64)  NULL,
  paid_at         DATETIME     NULL,
  -- Carry-over flags (set when a student is promoted with unpaid charges)
  is_carry_over          TINYINT(1)   NOT NULL DEFAULT 0,
  original_grade_level   VARCHAR(40)  NULL,
  original_school_year   VARCHAR(20)  NULL,
  carried_over_at        DATETIME     NULL,
  -- Archive flags (subjects + paid charges archived on promotion)
  is_archived               TINYINT(1)   NOT NULL DEFAULT 0,
  archived_at               DATETIME     NULL,
  archive_reason            VARCHAR(50)  NULL,
  archived_from_grade       VARCHAR(40)  NULL,
  archived_from_school_year VARCHAR(20)  NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_charges_student
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  KEY ix_charges_student (student_id),
  KEY ix_charges_source (source),
  KEY ix_charges_status (status),
  KEY ix_charges_archived (is_archived),
  KEY ix_charges_misc_fee (misc_fee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- PAYMENTS  (cash receipts; voided rows kept for audit, voided_at != NULL)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                VARCHAR(64)  NOT NULL PRIMARY KEY,
  student_id        VARCHAR(64)  NOT NULL,
  amount            DECIMAL(10,2) NOT NULL,
  discount_amount   DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_label    VARCHAR(200) NULL,
  discount_percent  DECIMAL(5,2) NULL,
  method            VARCHAR(40)  NOT NULL,
  reference         VARCHAR(100) NULL,
  received_by       VARCHAR(100) NULL,
  school_year       VARCHAR(20)  NULL,
  voided_at         DATETIME     NULL,
  void_reason       TEXT         NULL,
  voided_by         VARCHAR(100) NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_student
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  KEY ix_payments_student (student_id),
  KEY ix_payments_voided (voided_at),
  KEY ix_payments_school_year (school_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A payment can settle multiple charges (chargeIds[] in the original).
CREATE TABLE IF NOT EXISTS payment_charges (
  payment_id      VARCHAR(64)  NOT NULL,
  charge_id       VARCHAR(64)  NOT NULL,
  PRIMARY KEY (payment_id, charge_id),
  CONSTRAINT fk_pc_payment
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_charge
    FOREIGN KEY (charge_id)  REFERENCES charges(charge_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- ACTIVITY_LOG  (append-only audit trail)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  role            VARCHAR(40)  NULL,
  action          VARCHAR(100) NOT NULL,
  details         TEXT         NULL,
  timestamp       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_activity_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
