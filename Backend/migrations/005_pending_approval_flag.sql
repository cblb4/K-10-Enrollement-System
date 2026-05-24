-- ==========================================================================
-- Heartworks Learning Center — Enrollment System
-- Migration 005 — Two-phase approval (Pending vs Approved)
-- ==========================================================================
-- Previously a registrar's "Approve" click required every required document
-- to already be on file — otherwise the request was rejected outright. That
-- made walk-in workflows clumsy: parents often promise to bring missing
-- paperwork later, and the registrar had no way to record "I'm satisfied
-- with this student, hold the approval until the last document arrives".
--
-- This migration introduces a `pending_approval` flag on `students`:
--
--   - pending_approval = 1   → the registrar HAS approved the learner in
--                              principle; the system is just waiting for
--                              the remaining required documents. The
--                              student's `status` stays 'pending' until the
--                              last document is filed, at which point the
--                              service layer auto-flips status to
--                              'approved' (and applies school-wide fees).
--
--   - pending_approval = 0   → no pending approval intent. Status changes
--                              behave the same as before this migration.
--
-- The cashier's Collect Payment dropdown only shows students whose
-- `status = 'approved'`, so students with `pending_approval = 1` but still
-- missing documents stay out of the dropdown until paperwork is complete.
--
-- Compatible with MySQL 5.7+, MySQL 8.0, and MariaDB 10.x.
-- Run ONCE — the migrate runner records applied migrations.
-- ==========================================================================

USE hlc_enrollment;

ALTER TABLE students
  ADD COLUMN pending_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD KEY ix_students_pending_approval (pending_approval);
