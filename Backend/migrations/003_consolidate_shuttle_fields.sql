-- ==========================================================================
-- Heartworks Learning Center — Enrollment System
-- Migration 003 — Consolidate the Shuttle Service fields
-- ==========================================================================
-- The "Other Information" section originally had two shuttle-related fields:
--   * carpool_service  — free-text box   (BEING REMOVED)
--   * one_way_service  — dropdown        (KEPT, renamed to carpool_service)
--
-- End state: a single column `carpool_service` holding the dropdown value
-- ('none' | 'morning' | 'afternoon').
--
-- Order matters: the old text-box column must be dropped FIRST, otherwise
-- renaming one_way_service -> carpool_service would collide with it.
--
-- Compatible with MySQL 5.7, MySQL 8.0, and MariaDB.
-- (CHANGE COLUMN is used for the rename so it works on MySQL 5.7, which does
--  not support the newer RENAME COLUMN syntax.)
-- Run ONCE — the migrate runner records applied migrations.
-- ==========================================================================

USE hlc_enrollment;

-- Step 1 — drop the old free-text carpool column.
ALTER TABLE students
  DROP COLUMN carpool_service;

-- Step 2 — rename the dropdown column one_way_service -> carpool_service.
ALTER TABLE students
  CHANGE COLUMN one_way_service carpool_service VARCHAR(40) NULL;
