/**
 * storage.js
 *
 * Backend-aware data access layer. Same public API as the old
 * localStorage version, so all the module code (registrar.js, cashier.js,
 * admin.js, principal.js) keeps working with zero changes.
 *
 * How it works:
 *   1. bootstrap()   — async; called once at page load. Pulls every
 *                      collection from /api/bootstrap and warms an
 *                      in-memory cache.
 *   2. *.getAll/getById — synchronous, served from the cache.
 *   3. *.create/update/remove — synchronous *return* (so legacy code that
 *                      destructures the result keeps working), but they
 *                      fire off the network write in the background.
 *                      On failure the cache is rolled back and the user
 *                      gets a toast.
 *   4. Domain helpers (recordPayment, applySchoolWideFees, etc.) call the
 *                      dedicated API endpoint and *replace* the cached
 *                      student/payment with the server's authoritative
 *                      copy when the response comes back.
 *
 * The server is the source of truth. The cache is a read-through view of
 * the server, and any divergence is resolved with refresh().
 */
(function (global) {
  'use strict';

  const API = global.HLC_API;
  const U   = global.HLC_UTILS || {};

  if (!API) {
    throw new Error('HLC_STORAGE: api.js must load before storage.js');
  }

  // ─── In-memory cache ───────────────────────────────────────────────────
  const cache = {
    students:    [],
    payments:    [],
    sections:    [],
    activityLog: [],
    users:       [],
    subjects:    [],
    faculty:     [],
    miscFees:    [],
    settings:    {}
  };
  let bootstrapped = false;
  let bootstrapPromise = null;

  /**
   * Load every collection from the server. Idempotent — re-calling returns
   * the same in-flight promise instead of doing two round-trips.
   */
  async function bootstrap() {
    if (bootstrapped) return cache;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const data = await API.get('/api/bootstrap');
      cache.students    = data.students    || [];
      cache.payments    = data.payments    || [];
      cache.sections    = data.sections    || [];
      cache.subjects    = data.subjects    || [];
      cache.faculty     = data.faculty     || [];
      cache.miscFees    = data.miscFees    || [];
      cache.activityLog = data.activityLog || [];
      cache.users       = data.users       || [];
      cache.settings    = data.settings    || {};
      bootstrapped = true;
      return cache;
    })();
    try { return await bootstrapPromise; }
    finally { bootstrapPromise = null; }
  }

  /** Re-fetch from server, throwing away local cache. */
  async function refresh() {
    bootstrapped = false;
    return bootstrap();
  }

  // ─── Cache helpers ─────────────────────────────────────────────────────

  function _toast(msg) {
    if (U && typeof U.toast === 'function') U.toast(msg);
    else console.error(msg);
  }

  /**
   * Fire an async write in the background, with rollback semantics.
   * The optimistic cache update has already happened at call time;
   * this function only handles the network send + recovery.
   */
  function _bg(promiseFactory, opts) {
    opts = opts || {};
    Promise.resolve()
      .then(promiseFactory)
      .then(data => { if (opts.onSuccess) opts.onSuccess(data); })
      .catch(err => {
        try { if (opts.onFailure) opts.onFailure(err); } catch (_) {}
        const prefix = opts.errorPrefix || 'Save failed';
        _toast(prefix + ': ' + (err && err.message || 'unknown error'));
        // Refresh so the next read shows real state from the server.
        refresh().catch(() => {});
      });
  }

  // ─── Generic collection factory ────────────────────────────────────────
  // Mirrors the old createCollection() shape: getAll, getById, create,
  // update, remove, replaceAll. Reads are synchronous (cache); writes are
  // optimistic + fire to the API.

  function createCollection(cacheKey, endpoint, options) {
    options = options || {};
    const idKey = options.idKey || 'id';

    return {
      getAll() {
        return cache[cacheKey].slice();
      },
      getById(id) {
        return cache[cacheKey].find(x => x[idKey] === id) || null;
      },
      create(record) {
        // Optimistic: trust the caller's id (modules generate prefixed ids).
        const optimistic = { ...record };
        cache[cacheKey].push(optimistic);

        _bg(() => API.post(endpoint, record), {
          onSuccess(serverRow) {
            // Replace the optimistic copy with the server's row.
            const idx = cache[cacheKey].indexOf(optimistic);
            if (idx !== -1 && serverRow) cache[cacheKey][idx] = serverRow;
          },
          onFailure() {
            const idx = cache[cacheKey].indexOf(optimistic);
            if (idx !== -1) cache[cacheKey].splice(idx, 1);
          },
          errorPrefix: 'Create failed'
        });
        return optimistic;
      },
      update(id, patch) {
        const idx = cache[cacheKey].findIndex(x => x[idKey] === id);
        if (idx === -1) return null;
        const before = cache[cacheKey][idx];
        const optimistic = { ...before, ...patch, updatedAt: new Date().toISOString() };
        cache[cacheKey][idx] = optimistic;

        _bg(() => API.patch(`${endpoint}/${encodeURIComponent(id)}`, patch), {
          onSuccess(serverRow) {
            const j = cache[cacheKey].findIndex(x => x[idKey] === id);
            if (j !== -1 && serverRow) cache[cacheKey][j] = serverRow;
          },
          onFailure() {
            const j = cache[cacheKey].findIndex(x => x[idKey] === id);
            if (j !== -1) cache[cacheKey][j] = before;
          },
          errorPrefix: 'Update failed'
        });
        return optimistic;
      },
      remove(id) {
        const idx = cache[cacheKey].findIndex(x => x[idKey] === id);
        if (idx === -1) return false;
        const before = cache[cacheKey][idx];
        cache[cacheKey].splice(idx, 1);

        _bg(() => API.del(`${endpoint}/${encodeURIComponent(id)}`), {
          onFailure() {
            // Re-insert at original position if possible.
            cache[cacheKey].splice(Math.min(idx, cache[cacheKey].length), 0, before);
          },
          errorPrefix: 'Delete failed'
        });
        return true;
      },
      replaceAll(records) {
        // Used by legacy migrations (no longer needed, kept for compat).
        cache[cacheKey] = Array.isArray(records) ? records.slice() : [];
      }
    };
  }

  // ─── Domain collections ────────────────────────────────────────────────
  const Students    = createCollection('students',    '/api/students');
  const Payments    = createCollection('payments',    '/api/payments');
  const Sections    = createCollection('sections',    '/api/sections');
  const Subjects    = createCollection('subjects',    '/api/subjects');
  const Faculty     = createCollection('faculty',     '/api/faculty');
  const MiscFees    = createCollection('miscFees',    '/api/misc-fees');
  const ActivityLog = createCollection('activityLog', '/api/activity-log');
  const Users       = createCollection('users',       '/api/users');

  // Settings is a key/value store, not a list.
  const Settings = {
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(cache.settings, key)
        ? cache.settings[key]
        : defaultValue;
    },
    set(key, value) {
      const prev = cache.settings[key];
      cache.settings[key] = value;
      _bg(() => API.put('/api/settings/' + encodeURIComponent(key), { value }), {
        onFailure() { cache.settings[key] = prev; },
        errorPrefix: 'Settings save failed'
      });
      return value;
    },
    getAll() { return Object.assign({}, cache.settings); }
  };

  function getActiveSchoolYear() {
    const cfg = global.HLC_CONFIG || {};
    return Settings.get('activeSchoolYear', cfg.DEFAULT_SCHOOL_YEAR || '2025-2026');
  }
  function setActiveSchoolYear(sy) {
    if (!sy || typeof sy !== 'string') return null;
    const prev = cache.settings.activeSchoolYear;
    cache.settings.activeSchoolYear = sy;
    _bg(() => API.put('/api/settings/active-school-year', { schoolYear: sy }), {
      onFailure() { cache.settings.activeSchoolYear = prev; },
      errorPrefix: 'Active school year save failed'
    });
    return sy;
  }

  // ─── Known school years (the registrar-managed list) ───────────────────
  // Stored centrally under the `knownSchoolYears` settings key so every
  // module sees the same list. The active year is always implicitly known.
  function getKnownSchoolYears() {
    const list = Settings.get('knownSchoolYears', []);
    const set = new Set(Array.isArray(list) ? list : []);
    set.add(getActiveSchoolYear());            // active year is always present
    return Array.from(set).sort();
  }
  function addKnownSchoolYear(sy) {
    if (!sy || typeof sy !== 'string') return null;
    const list = getKnownSchoolYears();
    if (list.indexOf(sy) === -1) list.push(sy);
    list.sort();
    const prev = cache.settings.knownSchoolYears;
    cache.settings.knownSchoolYears = list;
    _bg(() => API.put('/api/settings/knownSchoolYears', { value: list }), {
      onFailure() { cache.settings.knownSchoolYears = prev; },
      errorPrefix: 'School year list save failed'
    });
    return list;
  }

  // ─── Domain-specific helpers ───────────────────────────────────────────
  // These all hit dedicated server endpoints and replace the cached student
  // (or payment) with the server's authoritative version when the response
  // comes back.

  function _replaceStudent(server) {
    if (!server) return;
    const idx = cache.students.findIndex(s => s.id === server.id);
    if (idx === -1) cache.students.push(server);
    else cache.students[idx] = server;
  }

  function _replacePayment(server) {
    if (!server) return;
    const idx = cache.payments.findIndex(p => p.id === server.id);
    if (idx === -1) cache.payments.push(server);
    else cache.payments[idx] = server;
  }

  /**
   * Add a charge to a student. Optimistically pushes a charge into the
   * student's local charges array, then resyncs from the server.
   */
  function addCharge(studentId, chargeData) {
    const student = Students.getById(studentId);
    if (!student) return null;
    const studentSY = student.schoolYear || getActiveSchoolYear();

    const optimistic = {
      chargeId: 'chg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: chargeData.title,
      amount: Number(chargeData.amount) || 0,
      description: chargeData.description || '',
      source: chargeData.source || 'manual',
      subjectId: chargeData.subjectId || null,
      miscFeeId: chargeData.miscFeeId || null,
      feeScope: chargeData.feeScope || null,
      category: chargeData.category || null,
      schoolYear: chargeData.schoolYear || studentSY,
      status: 'unpaid',
      createdAt: new Date().toISOString()
    };
    student.charges = (student.charges || []).concat([optimistic]);

    // The backend's `expect()` validator is strict: `amount` must be a real
    // JS number, not a number-as-string. The form input gives us a string,
    // so coerce here before sending. (We also keep `Number(...) || 0` on the
    // optimistic row above, so cache + server stay in sync.)
    const payload = {
      ...chargeData,
      amount: Number(chargeData.amount) || 0
    };

    _bg(
      () => API.post(`/api/students/${encodeURIComponent(studentId)}/charges`, payload),
      {
        onSuccess(resp) { _replaceStudent(resp && resp.student); },
        onFailure() {
          student.charges = (student.charges || []).filter(c => c !== optimistic);
        },
        errorPrefix: 'Add charge failed'
      }
    );
    return student;
  }

  /**
   * Bridge: assign one or more subjects to a student. Each becomes a
   * zero-amount source:'subject' charge. Mirrors server dedup logic.
   */
  function assignSubjectsToStudent(studentId, subjectIds) {
    const student = Students.getById(studentId);
    if (!student) return { assigned: [], skipped: [] };

    const existing = Array.isArray(student.charges) ? student.charges : [];
    const alreadyIds = new Set(existing.filter(c => c.source === 'subject').map(c => c.subjectId));

    const assigned = [];
    const skipped = [];
    const optimisticCharges = [];

    subjectIds.forEach(sid => {
      if (alreadyIds.has(sid)) { skipped.push(sid); return; }
      const subject = Subjects.getById(sid);
      if (!subject) return;
      const optimistic = {
        chargeId: 'chg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: subject.name,
        amount: 0,
        description: subject.description || ('Subject fee for ' + subject.name),
        source: 'subject',
        subjectId: subject.id,
        miscFeeId: null,
        feeScope: null,
        category: null,
        schoolYear: student.schoolYear || getActiveSchoolYear(),
        status: 'unpaid',
        createdAt: new Date().toISOString()
      };
      optimisticCharges.push(optimistic);
      assigned.push(subject);
    });
    student.charges = (student.charges || []).concat(optimisticCharges);

    _bg(
      () => API.post(`/api/students/${encodeURIComponent(studentId)}/subjects`, { subjectIds }),
      {
        onSuccess(resp) { _replaceStudent(resp && resp.student); },
        onFailure() {
          student.charges = (student.charges || []).filter(c => !optimisticCharges.includes(c));
        },
        errorPrefix: 'Assign subjects failed'
      }
    );
    return { assigned, skipped };
  }

  /**
   * Bridge: apply every auto-apply misc fee that targets this student.
   * Server-side dedupes by miscFeeId. Mirrors logic locally so callers
   * see results synchronously.
   */
  function applySchoolWideFees(studentId) {
    const student = Students.getById(studentId);
    if (!student) return [];

    const existing = Array.isArray(student.charges) ? student.charges : [];
    const alreadyApplied = new Set(
      existing.filter(c => c.source === 'misc-fee').map(c => c.miscFeeId)
    );
    const studentGrade = student.gradeLevel || '';
    const studentSY = student.schoolYear || getActiveSchoolYear();

    const applied = [];
    const optimisticCharges = [];
    MiscFees.getAll().forEach(fee => {
      if (!fee.autoApply) return;
      const feeSY = fee.schoolYear || getActiveSchoolYear();
      if (feeSY !== studentSY) return;
      let matches = false;
      if (fee.scope === 'school') matches = true;
      else if (fee.scope === 'grades') {
        matches = Array.isArray(fee.gradeLevels) && fee.gradeLevels.includes(studentGrade);
      }
      if (!matches) return;
      if (alreadyApplied.has(fee.id)) return;

      const optimistic = {
        chargeId: 'chg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: fee.name,
        amount: fee.amount,
        description: fee.description || '',
        source: 'misc-fee',
        miscFeeId: fee.id,
        feeScope: fee.scope,
        category: fee.category || (fee.scope === 'grades' ? 'Grade-level' : 'School-wide'),
        schoolYear: fee.schoolYear || studentSY,
        status: 'unpaid',
        createdAt: new Date().toISOString()
      };
      optimisticCharges.push(optimistic);
      applied.push(fee);
    });
    if (optimisticCharges.length) {
      student.charges = (student.charges || []).concat(optimisticCharges);
    }
    _bg(
      () => API.post(`/api/students/${encodeURIComponent(studentId)}/auto-fees`),
      {
        onSuccess(resp) { _replaceStudent(resp && resp.student); },
        onFailure() {
          student.charges = (student.charges || []).filter(c => !optimisticCharges.includes(c));
        },
        errorPrefix: 'Apply auto fees failed'
      }
    );
    return applied;
  }

  /**
   * Apply ONE optional misc fee. Returns the fee on success, null if
   * already applied or not found (matches old behavior).
   */
  function applyMiscFee(studentId, miscFeeId) {
    const fee = MiscFees.getById(miscFeeId);
    if (!fee) return null;
    const student = Students.getById(studentId);
    if (!student) return null;
    const existing = (student.charges || []).find(c =>
      c.source === 'misc-fee' && c.miscFeeId === miscFeeId
    );
    if (existing) return null;

    const optimistic = {
      chargeId: 'chg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: fee.name,
      amount: fee.amount,
      description: fee.description || '',
      source: 'misc-fee',
      miscFeeId: fee.id,
      feeScope: fee.scope,
      category: fee.category || 'Optional',
      schoolYear: fee.schoolYear || student.schoolYear || getActiveSchoolYear(),
      status: 'unpaid',
      createdAt: new Date().toISOString()
    };
    student.charges = (student.charges || []).concat([optimistic]);

    _bg(
      () => API.post(`/api/students/${encodeURIComponent(studentId)}/optional-fees`, { miscFeeId }),
      {
        onSuccess(resp) { _replaceStudent(resp && resp.student); },
        onFailure() {
          student.charges = (student.charges || []).filter(c => c !== optimistic);
        },
        errorPrefix: 'Apply optional fee failed'
      }
    );
    return fee;
  }

  /**
   * Build a Generated Schedule and Assessment view-model — pure local
   * computation against the cached student. Kept verbatim from the
   * original storage.js so all GSA callers continue to work unchanged.
   */
  function buildGSA(studentId) {
    const student = Students.getById(studentId);
    if (!student) return null;

    const charges = Array.isArray(student.charges) ? student.charges : [];
    const feesById = Object.fromEntries(MiscFees.getAll().map(f => [f.id, f]));

    const subjects = charges.filter(c => c.source === 'subject');
    const schoolWideFees = charges.filter(c => {
      if (c.source !== 'misc-fee') return false;
      if (c.feeScope) return c.feeScope === 'school' || c.feeScope === 'grades';
      const fee = feesById[c.miscFeeId];
      return fee ? (fee.scope === 'school' || fee.scope === 'grades') : false;
    });
    const optionalFees = charges.filter(c => {
      if (c.source !== 'misc-fee') return false;
      if (c.feeScope) return c.feeScope === 'optional';
      const fee = feesById[c.miscFeeId];
      return fee ? fee.scope === 'optional' : true;
    });
    const manualCharges = charges.filter(c => c.source === 'manual');
    const discounts = charges.filter(c => c.source === 'discount');

    const sum = arr => arr.reduce((t, c) => t + (Number(c.amount) || 0), 0);
    const sumPaid = arr => arr.filter(c => c.status === 'paid').reduce((t, c) => t + (Number(c.amount) || 0), 0);

    const subjectsAssessed   = sum(subjects);
    const schoolFeesAssessed = sum(schoolWideFees);
    const optionalAssessed   = sum(optionalFees);
    const manualAssessed     = sum(manualCharges);
    const cashierDiscountTotal = Math.abs(sum(discounts));

    const grossTotal = subjectsAssessed + schoolFeesAssessed + optionalAssessed + manualAssessed;
    const enrollmentDiscount = computeDiscount(student, grossTotal);
    const netTotal = Math.max(0, grossTotal - enrollmentDiscount - cashierDiscountTotal);

    const cashPaid = Payments.getAll()
      .filter(p => p.studentId === student.id && !p.voidedAt)
      .reduce((t, p) => t + (Number(p.amount) || 0), 0);
    const totalBalance = netTotal - cashPaid;

    let overallStatus = 'unpaid';
    if (netTotal > 0 && totalBalance <= 0) overallStatus = 'paid';
    else if (cashPaid > 0 || cashierDiscountTotal > 0) overallStatus = 'partial';

    const paymentMode = student.paymentMode || 'full';
    const paymentSchedule = buildPaymentSchedule(paymentMode, netTotal);

    return {
      student,
      subjects, schoolWideFees, optionalFees, manualCharges, discounts,
      misc: [...schoolWideFees, ...optionalFees, ...manualCharges],
      discount: student.discount || null,
      discountAmount: enrollmentDiscount,
      paymentMode,
      paymentSchedule,
      totals: {
        subjectsAssessed,
        subjectsPaid: sumPaid(subjects),
        schoolFeesAssessed,
        schoolFeesPaid: sumPaid(schoolWideFees),
        optionalAssessed,
        optionalPaid: sumPaid(optionalFees),
        manualAssessed,
        manualPaid: sumPaid(manualCharges),
        miscAssessed: schoolFeesAssessed + optionalAssessed + manualAssessed,
        miscPaid: sumPaid([...schoolWideFees, ...optionalFees, ...manualCharges]),
        grossTotal,
        enrollmentDiscount,
        cashierDiscountTotal,
        discountAmount: enrollmentDiscount,
        netTotal,
        totalAssessed: netTotal,
        cashPaid,
        totalPaid: cashPaid,
        totalBalance,
        overallStatus
      }
    };
  }

  function computeDiscount(student, grossTotal) {
    const d = student.discount;
    if (!d) return 0;
    if (d.percent && d.percent > 0) {
      return Math.round((grossTotal * (d.percent / 100)) * 100) / 100;
    }
    return Number(d.amount) || 0;
  }

  function buildPaymentSchedule(mode, netTotal) {
    if (!netTotal) return [{ label: 'No assessment', dueOn: '—', amount: 0 }];
    if (mode === 'installment_2') {
      const half = Math.round((netTotal / 2) * 100) / 100;
      return [
        { label: '1st Installment',  dueOn: 'Upon enrollment', amount: half },
        { label: '2nd Installment',  dueOn: 'Mid-year',        amount: netTotal - half }
      ];
    }
    if (mode === 'installment_3') {
      const third = Math.round((netTotal / 3) * 100) / 100;
      const second = Math.round((netTotal / 3) * 100) / 100;
      const last = Math.round((netTotal - third - second) * 100) / 100;
      return [
        { label: '1st Installment', dueOn: 'Upon enrollment',     amount: third },
        { label: '2nd Installment', dueOn: 'End of 1st quarter',  amount: second },
        { label: '3rd Installment', dueOn: 'End of 2nd quarter',  amount: last }
      ];
    }
    return [{ label: 'Full Payment', dueOn: 'Upon enrollment', amount: netTotal }];
  }

  /**
   * Record a payment. Optimistically:
   *   - inserts a payment row in the cache
   *   - flips the targeted charges to 'paid'
   *   - appends a synthetic discount charge if discountAmount > 0
   * Then sends to /api/students/:id/payments. On response, the cached
   * student + payment are replaced with the server's authoritative copies.
   *
   * Returns the optimistic payment object synchronously (legacy callers
   * read its `id` for receipt printing immediately).
   */
  function recordPayment(studentId, paymentData) {
    const student = Students.getById(studentId);
    if (!student) return null;

    const cashAmount     = Number(paymentData.amount) || 0;
    const discountAmount = Number(paymentData.discountAmount) || 0;
    const discountLabel  = (paymentData.discountLabel || '').trim();
    const discountPercent = paymentData.discountPercent != null ? Number(paymentData.discountPercent) : null;
    const chargeIds = paymentData.chargeIds || [];

    const optimisticPayment = {
      id: 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      studentId,
      amount: cashAmount,
      discountAmount,
      discountLabel,
      discountPercent,
      method: paymentData.method,
      reference: paymentData.reference || '',
      chargeIds: chargeIds.slice(),
      receivedBy: paymentData.receivedBy || 'cashier',
      schoolYear: paymentData.schoolYear || student.schoolYear || getActiveSchoolYear(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      createdAt: new Date().toISOString()
    };
    cache.payments.push(optimisticPayment);

    if (Array.isArray(student.charges) && chargeIds.length) {
      const targetSet = new Set(chargeIds);
      student.charges = student.charges.map(c =>
        targetSet.has(c.chargeId) ? { ...c, status: 'paid', paidAt: optimisticPayment.createdAt } : c
      );
      if (discountAmount > 0) {
        student.charges = student.charges.concat([{
          chargeId: 'chg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          title: discountLabel ? `Discount — ${discountLabel}` : 'Discount',
          amount: -discountAmount,
          description: discountPercent
            ? `Cashier-applied ${discountPercent}% discount on ₱${(cashAmount + discountAmount).toFixed(2)} of charges`
            : `Cashier-applied discount on payment ${optimisticPayment.id.slice(-8).toUpperCase()}`,
          source: 'discount',
          paymentId: optimisticPayment.id,
          status: 'paid',
          paidAt: optimisticPayment.createdAt,
          createdAt: optimisticPayment.createdAt
        }]);
      }
    }

    _bg(
      () => API.post(
        `/api/students/${encodeURIComponent(studentId)}/payments`,
        {
          amount: cashAmount,
          method: paymentData.method,
          reference: paymentData.reference || '',
          receivedBy: paymentData.receivedBy || 'cashier',
          chargeIds,
          discountAmount,
          discountLabel,
          discountPercent
        }
      ),
      {
        onSuccess(resp) {
          if (resp && resp.payment) {
            const optIdx = cache.payments.indexOf(optimisticPayment);
            if (optIdx !== -1) cache.payments[optIdx] = resp.payment;
            else _replacePayment(resp.payment);
          }
          if (resp && resp.student) _replaceStudent(resp.student);
        },
        onFailure() {
          const i = cache.payments.indexOf(optimisticPayment);
          if (i !== -1) cache.payments.splice(i, 1);
        },
        errorPrefix: 'Record payment failed'
      }
    );
    return optimisticPayment;
  }

  /**
   * Void a previously-recorded payment. Optimistically stamps voidedAt on
   * the cached payment, flips associated charges back to unpaid, removes
   * the synthetic discount charge. Server response replaces both records.
   */
  function voidPayment(paymentId, options) {
    options = options || {};
    const payment = Payments.getById(paymentId);
    if (!payment) return null;
    if (payment.voidedAt) return payment;

    const before = { ...payment };
    payment.voidedAt = new Date().toISOString();
    payment.voidReason = (options.reason || '').trim() || null;
    payment.voidedBy   = (options.voidedBy || '').trim() || null;

    const student = Students.getById(payment.studentId);
    let beforeCharges = null;
    if (student && Array.isArray(student.charges)) {
      beforeCharges = student.charges;
      const targetSet = new Set(payment.chargeIds || []);
      student.charges = student.charges
        .filter(c => !(c.source === 'discount' && c.paymentId === paymentId))
        .map(c => targetSet.has(c.chargeId) ? { ...c, status: 'unpaid', paidAt: null } : c);
    }

    _bg(
      () => API.post(
        `/api/payments/${encodeURIComponent(paymentId)}/void`,
        { reason: options.reason, voidedBy: options.voidedBy }
      ),
      {
        onSuccess(resp) {
          if (resp && resp.payment) _replacePayment(resp.payment);
          if (resp && resp.student) _replaceStudent(resp.student);
        },
        onFailure() {
          Object.assign(payment, before);
          if (student && beforeCharges) student.charges = beforeCharges;
        },
        errorPrefix: 'Void payment failed'
      }
    );
    return payment;
  }

  /**
   * Change a student's grade (correction or promotion). Heavy lifting
   * happens server-side in a transaction; we patch the cached student
   * optimistically and let the server response fill in real numbers.
   */
  function changeStudentGrade(studentId, newGrade, options) {
    options = options || {};
    const student = Students.getById(studentId);
    if (!student || !newGrade) return null;

    const previousGrade = student.gradeLevel;
    const previousSY = student.schoolYear;
    student.gradeLevel = newGrade;
    if (options.reason === 'promotion' && options.newSchoolYear) {
      student.schoolYear = options.newSchoolYear;
    }

    const placeholder = {
      student,
      appliedFees: [],
      archivedCount: 0,
      carryOverCount: 0,
      carryOverAmount: 0
    };

    _bg(
      () => API.post(
        `/api/students/${encodeURIComponent(studentId)}/grade-change`,
        {
          newGrade,
          reason: options.reason,
          newSchoolYear: options.newSchoolYear
        }
      ),
      {
        onSuccess(resp) {
          if (resp && resp.student) {
            _replaceStudent(resp.student);
            placeholder.student = resp.student;
            placeholder.appliedFees = resp.appliedFees || [];
            placeholder.archivedCount = resp.archivedCount || 0;
            placeholder.carryOverCount = resp.carryOverCount || 0;
            placeholder.carryOverAmount = resp.carryOverAmount || 0;
          }
        },
        onFailure() {
          student.gradeLevel = previousGrade;
          if (options.reason === 'promotion' && options.newSchoolYear) {
            student.schoolYear = previousSY;
          }
        },
        errorPrefix: 'Grade change failed'
      }
    );
    return placeholder;
  }

  /**
   * Edit an existing miscellaneous fee. Server forward-applies to any
   * newly-matching students; we patch the local fee + refresh affected
   * students from their canonical server copy.
   */
  function editMiscFee(feeId, patch) {
    const existing = MiscFees.getById(feeId);
    if (!existing) return null;

    const merged = { ...existing, ...patch };
    if (merged.scope !== 'grades') merged.gradeLevels = [];
    merged.autoApply = (merged.scope === 'school' || merged.scope === 'grades');

    // Optimistic local update.
    const idx = cache.miscFees.findIndex(f => f.id === feeId);
    if (idx !== -1) cache.miscFees[idx] = merged;

    const result = { fee: merged, retroAppliedToStudentIds: [] };

    _bg(
      () => API.patch(`/api/misc-fees/${encodeURIComponent(feeId)}`, {
        name:        merged.name,
        amount:      Number(merged.amount) || 0,
        category:    merged.category,
        scope:       merged.scope,
        gradeLevels: merged.gradeLevels,
        description: merged.description || '',
        schoolYear:  merged.schoolYear
      }),
      {
        onSuccess(resp) {
          if (resp && resp.fee) {
            const j = cache.miscFees.findIndex(f => f.id === feeId);
            if (j !== -1) cache.miscFees[j] = resp.fee;
            result.fee = resp.fee;
          }
          if (resp && Array.isArray(resp.retroAppliedToStudentIds)) {
            result.retroAppliedToStudentIds = resp.retroAppliedToStudentIds;
            for (const sid of resp.retroAppliedToStudentIds) {
              API.get(`/api/students/${encodeURIComponent(sid)}`)
                .then(s => _replaceStudent(s))
                .catch(() => {});
            }
          }
        },
        onFailure() {
          const j = cache.miscFees.findIndex(f => f.id === feeId);
          if (j !== -1) cache.miscFees[j] = existing;
        },
        errorPrefix: 'Edit fee failed'
      }
    );
    return result;
  }

  /**
   * Append an audit log entry. Fire-and-forget; failures are logged but
   * not surfaced (audit logging shouldn't interrupt the user).
   */
  function logActivity(role, action, details) {
    const optimistic = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      role: role || null,
      action,
      details: details || '',
      timestamp: new Date().toISOString()
    };
    cache.activityLog.unshift(optimistic);

    Promise.resolve()
      .then(() => API.post('/api/activity-log', { role, action, details }))
      .then(server => {
        const i = cache.activityLog.indexOf(optimistic);
        if (i !== -1 && server) cache.activityLog[i] = server;
      })
      .catch(err => {
        // Silent — don't disrupt UX over a missing log entry.
        console.warn('Activity log failed:', err && err.message);
      });
  }

  // ─── Public API ────────────────────────────────────────────────────────
  global.HLC_STORAGE = {
    bootstrap,
    refresh,
    Students,
    Payments,
    Sections,
    ActivityLog,
    Users,
    Subjects,
    Faculty,
    MiscFees,
    Settings,
    addCharge,
    assignSubjectsToStudent,
    applySchoolWideFees,
    applyMiscFee,
    buildGSA,
    recordPayment,
    voidPayment,
    changeStudentGrade,
    editMiscFee,
    getActiveSchoolYear,
    setActiveSchoolYear,
    getKnownSchoolYears,
    addKnownSchoolYear,
    logActivity
  };
})(window);
