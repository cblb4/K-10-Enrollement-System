/**
 * config.js
 * Application-wide configuration constants.
 * Centralizing these makes it trivial to swap to env-vars or a backend later.
 */
(function (global) {
  'use strict';

  const CONFIG = {
    APP_NAME: 'Heartworks Learning Center',
    APP_TAGLINE: 'Student Enrollment System',
    // Base URL of the Heartworks backend. If you deploy this to production,
    // change this to the public API URL (or empty string for same-origin).
    API_BASE: 'http://localhost:4000',
    GRADE_LEVELS: [
      'Kindergarten',
      'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5',
      'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'
    ],
    ENROLLMENT_STATUSES: ['pending', 'approved', 'rejected', 'enrolled'],
    PAYMENT_STATUSES: ['unpaid', 'partial', 'paid'],
    ROLES: ['registrar', 'cashier', 'admin', 'principal'],
    ROLE_LABELS: {
      registrar: 'Registrar',
      cashier: 'Cashier',
      admin: 'Business Admin',
      principal: 'Principal'
    },
    ROLE_HOMES: {
      registrar: 'modules/registrar/registrar.html',
      cashier: 'modules/cashier/cashier.html',
      admin: 'modules/admin/admin.html',
      principal: 'modules/principal/principal.html'
    },
    STORAGE_KEYS: {
      STUDENTS: 'hlc_students',
      PAYMENTS: 'hlc_payments',
      SECTIONS: 'hlc_sections',
      ACTIVITY_LOG: 'hlc_activity_log',
      USERS: 'hlc_users',
      SUBJECTS: 'hlc_subjects',
      FACULTY: 'hlc_faculty',
      MISC_FEES: 'hlc_misc_fees',
      SETTINGS: 'hlc_settings',
      CURRENT_USER: 'hlc_current_user'
    },
    CURRENCY: '₱',
    // Default school year used to stamp records that pre-date the school-year
    // feature. The cashier's settings UI lets administrators change the
    // active school year at runtime — that override lives in Settings, this
    // is just the fallback.
    DEFAULT_SCHOOL_YEAR: '2025-2026'
  };

  global.HLC_CONFIG = CONFIG;
})(window);
