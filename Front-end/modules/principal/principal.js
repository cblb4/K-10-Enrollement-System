/**
 * principal.js
 * DIKW analytics for school leadership.
 *
 *   Data        → raw entries
 *   Information → aggregated metrics
 *   Knowledge   → patterns and trends
 *   Wisdom      → strategic recommendations
 */
(function () {
  'use strict';

  // Auth guard FIRST
  const me = window.HLC_AUTH.requireRole('principal', '../../auth.html');
  if (!me) return;

  const { Students, Payments, Sections, getActiveSchoolYear } = window.HLC_STORAGE;
  const U = window.HLC_UTILS;
  const CFG = window.HLC_CONFIG;
  const $ = U.$, $$ = U.$$;

  // Render shared chrome
  window.HLC_LOGO.renderLogo('#sidebar-logo');
  (function renderUserStrip() {
    const host = $('#user-strip');
    if (!host) return;
    host.className = 'user-strip';
    const safe = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    host.innerHTML = `
      <div class="name">${safe(me.fullName)}</div>
      <div class="email">${safe(me.email)}</div>
      <button class="logout-btn" id="logout-btn">Sign Out</button>
    `;
    $('#logout-btn').addEventListener('click', () => {
      window.HLC_AUTH.logout();
      window.location.replace('../../auth.html');
    });
  })();

  function fullName(s) { return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '); }
  function daysSince(iso) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }

  // ----------- View routing -----------
  function setActiveView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-list button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    const titles = {
      data:        ['Layer 1 · Raw',         'Data'],
      information: ['Layer 2 · Aggregated',  'Information'],
      knowledge:   ['Layer 3 · Patterns',    'Knowledge'],
      wisdom:      ['Layer 4 · Action',      'Wisdom']
    };
    const [eyebrow, title] = titles[name] || titles.data;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    if (name === 'data')        renderData();
    if (name === 'information') renderInformation();
    if (name === 'knowledge')   renderKnowledge();
    if (name === 'wisdom')      renderWisdom();
  }

  // ============================================================
  // LAYER 1 — DATA: raw entries as recorded
  // ============================================================
  function renderData() {
    const students = Students.getAll();
    const payments = Payments.getAll();
    const allCharges = [];
    students.forEach(s => (s.charges || []).forEach(c => allCharges.push({ student: s, charge: c })));

    const stats = $('#data-stats');
    U.clearNode(stats);
    [
      { label: 'Student Records', value: String(students.length) },
      { label: 'Charge Entries',  value: String(allCharges.length) },
      { label: 'Payment Logs',    value: String(payments.length), gold: true },
      { label: 'Sections',        value: String(Sections.getAll().length) }
    ].forEach(t => {
      stats.appendChild(U.el('div', { class: 'stat' + (t.gold ? ' gold' : '') }, [
        U.el('div', { class: 'label' }, t.label),
        U.el('div', { class: 'value' }, t.value)
      ]));
    });

    // Students table
    const sb = $('#data-students-tbl tbody'); U.clearNode(sb);
    $('#data-students-count').textContent = `${students.length} record${students.length === 1 ? '' : 's'}`;
    if (!students.length) {
      sb.appendChild(emptyRow(4, 'No student records yet.'));
    } else {
      students.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12).forEach(s => {
        const tr = document.createElement('tr');
        tr.appendChild(U.el('td', { style: 'font-weight:500;' }, fullName(s)));
        tr.appendChild(U.el('td', {}, s.gradeLevel));
        const pillTd = document.createElement('td');
        pillTd.appendChild(U.el('span', { class: 'pill pill-' + s.status }, s.status));
        tr.appendChild(pillTd);
        tr.appendChild(U.el('td', {}, U.formatDate(s.createdAt)));
        sb.appendChild(tr);
      });
    }

    // Charges table
    const cb = $('#data-charges-tbl tbody'); U.clearNode(cb);
    $('#data-charges-count').textContent = `${allCharges.length} charge${allCharges.length === 1 ? '' : 's'}`;
    if (!allCharges.length) {
      cb.appendChild(emptyRow(5, 'No charges recorded yet.'));
    } else {
      allCharges.sort((a, b) => new Date(b.charge.createdAt) - new Date(a.charge.createdAt)).slice(0, 12).forEach(({ student, charge }) => {
        const tr = document.createElement('tr');
        tr.appendChild(U.el('td', {}, fullName(student)));
        tr.appendChild(U.el('td', {}, charge.title));
        tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(charge.amount)));
        const pillTd = document.createElement('td');
        pillTd.appendChild(U.el('span', { class: 'pill pill-' + charge.status }, charge.status));
        tr.appendChild(pillTd);
        tr.appendChild(U.el('td', {}, U.formatDate(charge.createdAt)));
        cb.appendChild(tr);
      });
    }

    // Payments table
    const pb = $('#data-payments-tbl tbody'); U.clearNode(pb);
    $('#data-payments-count').textContent = `${payments.length} log${payments.length === 1 ? '' : 's'}`;
    if (!payments.length) {
      pb.appendChild(emptyRow(4, 'No payments yet.'));
    } else {
      payments.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12).forEach(p => {
        const s = Students.getById(p.studentId);
        const tr = document.createElement('tr');
        tr.appendChild(U.el('td', {}, s ? fullName(s) : '— Removed —'));
        tr.appendChild(U.el('td', {}, p.method));
        tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(p.amount)));
        tr.appendChild(U.el('td', {}, U.formatDateTime(p.createdAt)));
        pb.appendChild(tr);
      });
    }
  }

  function emptyRow(cols, msg) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = cols;
    td.style.padding = '32px';
    td.style.textAlign = 'center';
    td.style.color = 'var(--ink-500)';
    td.textContent = msg;
    tr.appendChild(td);
    return tr;
  }

  // ============================================================
  // LAYER 2 — INFORMATION: aggregated metrics
  // ============================================================
  // Tracks the Information view's school-year filter ('all' or a specific SY).
  let infoSchoolYear = 'all';

  // Build the list of school years present in the data, for the filter.
  function schoolYearsInData() {
    const set = new Set();
    Students.getAll().forEach(s => { if (s.schoolYear) set.add(s.schoolYear); });
    const active = getActiveSchoolYear && getActiveSchoolYear();
    if (active) set.add(active);
    return Array.from(set).sort();
  }

  function initInformationFilter() {
    const sel = $('#info-sy-filter');
    if (!sel) return;
    // Preserve the "All" option, append discovered years.
    schoolYearsInData().forEach(sy => {
      sel.appendChild(U.el('option', { value: sy }, sy));
    });
    // Default the filter to the active school year if it exists in the data.
    const active = getActiveSchoolYear && getActiveSchoolYear();
    if (active && schoolYearsInData().indexOf(active) !== -1) {
      sel.value = active;
      infoSchoolYear = active;
    }
    sel.addEventListener('change', () => {
      infoSchoolYear = sel.value;
      renderInformation();
    });
  }

  function renderInformation() {
    // Scope the dataset by the selected school year.
    const allStudents = Students.getAll();
    const students = infoSchoolYear === 'all'
      ? allStudents
      : allStudents.filter(s => s.schoolYear === infoSchoolYear);
    const studentIds = new Set(students.map(s => s.id));
    const payments = Payments.getAll().filter(p =>
      infoSchoolYear === 'all' ? true
        : (p.schoolYear === infoSchoolYear || studentIds.has(p.studentId)));

    const hint = $('#info-sy-hint');
    if (hint) {
      hint.textContent = infoSchoolYear === 'all'
        ? `Showing all ${allStudents.length} students`
        : `Showing ${students.length} student(s) for ${infoSchoolYear}`;
    }

    const totalCharges  = students.reduce((s, st) => s + U.sumCharges(st), 0);
    const totalPaid     = payments.reduce((s, p) => s + p.amount, 0);
    const totalStudents = students.length;
    const avgPerStudent = totalStudents ? totalCharges / totalStudents : 0;
    const collectionRate = totalCharges > 0
      ? Math.round((totalPaid / totalCharges) * 100) : 0;
    const outstanding = Math.max(0, totalCharges - totalPaid);

    const stats = $('#info-stats');
    U.clearNode(stats);
    [
      { label: 'Total Students',  value: String(totalStudents) },
      { label: 'Total Charges',   value: U.formatCurrency(totalCharges) },
      { label: 'Total Payments',  value: U.formatCurrency(totalPaid), gold: true },
      { label: 'Outstanding',     value: U.formatCurrency(outstanding) },
      { label: 'Collection Rate', value: collectionRate + '%' },
      { label: 'Avg / Student',   value: U.formatCurrency(avgPerStudent) }
    ].forEach(t => {
      stats.appendChild(U.el('div', { class: 'stat' + (t.gold ? ' gold' : '') }, [
        U.el('div', { class: 'label' }, t.label),
        U.el('div', { class: 'value' }, t.value)
      ]));
    });

    // Grade chart
    const grades = U.groupBy(students, s => s.gradeLevel);
    const max = Math.max(1, ...Object.values(grades).map(arr => arr.length));
    const gc = $('#info-grade-chart');
    U.clearNode(gc);
    CFG.GRADE_LEVELS.forEach(g => {
      const count = (grades[g] || []).length;
      gc.appendChild(U.el('div', { class: 'bar-row' }, [
        U.el('div', { class: 'lbl' }, g),
        U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: `width:${(count/max)*100}%;` })]),
        U.el('div', { class: 'num' }, String(count))
      ]));
    });

    // Charges vs Payments per grade
    const fc = $('#info-finance-chart');
    U.clearNode(fc);
    const financeMaxCharges = Math.max(1, ...CFG.GRADE_LEVELS.map(g => {
      return (grades[g] || []).reduce((s, st) => s + U.sumCharges(st), 0);
    }));
    CFG.GRADE_LEVELS.forEach(g => {
      const studentsInGrade = grades[g] || [];
      const charged = studentsInGrade.reduce((s, st) => s + U.sumCharges(st), 0);
      const paid = studentsInGrade.reduce((s, st) => s + U.sumPaidCharges(st), 0);

      fc.appendChild(U.el('div', { class: 'bar-row' }, [
        U.el('div', { class: 'lbl' }, g + ' · Billed'),
        U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: `width:${(charged/financeMaxCharges)*100}%;` })]),
        U.el('div', { class: 'num' }, U.formatCurrency(charged))
      ]));
      fc.appendChild(U.el('div', { class: 'bar-row' }, [
        U.el('div', { class: 'lbl', style: 'color:var(--gold-700);' }, g + ' · Paid'),
        U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill gold', style: `width:${(paid/financeMaxCharges)*100}%;` })]),
        U.el('div', { class: 'num' }, U.formatCurrency(paid))
      ]));
    });

    // Enrollment-by-status chart (new).
    const sc = $('#info-status-chart');
    if (sc) {
      U.clearNode(sc);
      const STATUSES = ['pending', 'approved', 'enrolled', 'rejected'];
      const byStatus = U.groupBy(students, s => s.status);
      const statusMax = Math.max(1, ...STATUSES.map(st => (byStatus[st] || []).length));
      STATUSES.forEach(st => {
        const count = (byStatus[st] || []).length;
        sc.appendChild(U.el('div', { class: 'bar-row' }, [
          U.el('div', { class: 'lbl' }, st.charAt(0).toUpperCase() + st.slice(1)),
          U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: `width:${(count/statusMax)*100}%;` })]),
          U.el('div', { class: 'num' }, String(count))
        ]));
      });
    }
  }

  // ============================================================
  // ANALYTICS PRIMITIVES
  // ------------------------------------------------------------
  // Shared computations used by BOTH the Knowledge layer (display)
  // and the Wisdom layer (prescriptive). Centralizing this means the
  // recommendations always reference the same signals the principal
  // sees on screen — the D→I→K→W chain stays internally consistent.
  // ============================================================

  // Charges this old (in days) without payment count as "aged" debt.
  // Used by risk segmentation + the aged-delay heuristic.
  const AGED_DAY_THRESHOLD = 14;

  // Used by the diagnostic-by-source breakdown to give human labels to
  // the raw `source` / `feeScope` / `isCarryOver` combinations on charges.
  function classifyChargeBucket(charge) {
    if (charge.isCarryOver) return 'Carry-over (prior term)';
    const src = charge.source || 'manual';
    if (src === 'misc-fee') {
      // Drill in: school-wide vs grade-level (vs optional, which has
      // feeScope='optional' or no autoApply flag downstream).
      if (charge.feeScope === 'school' || charge.category === 'School-wide') return 'School-wide fee';
      if (charge.feeScope === 'grades' || charge.category === 'Grade-level') return 'Grade-level fee';
      return 'Optional / misc fee';
    }
    if (src === 'subject')  return 'Subject placeholder';
    if (src === 'discount') return 'Discount';
    return 'Manual / one-off';
  }

  function flattenCharges(students) {
    const out = [];
    students.forEach(s => (s.charges || []).forEach(c => out.push({ student: s, charge: c })));
    return out;
  }

  /**
   * Enrollment forecast for the school year after the most recent one
   * present in the data. Two methods, picked automatically:
   *
   *   1. "Cohort progression" (always available): next year's Grade N
   *      headcount ≈ this year's Grade N-1 headcount (assumes 100%
   *      promotion). Kindergarten is held flat from current.
   *
   *   2. "Year-over-year adjusted" (needs 2+ school years with data):
   *      project the cohort, then scale by the year-over-year growth
   *      observed in that cohort, clamped to ±30% so a tiny sample of
   *      one outlier student can't blow the forecast up by 5x.
   *
   * Returns { current, projected, currentYear, nextYear, method,
   *   methodNote, sampleSize, isReliable } so both the Knowledge layer
   * (chart) and Wisdom (recommendations) can read the same numbers.
   */
  function computeEnrollmentForecast(students) {
    const enrolled = students.filter(s => s.status === 'approved' || s.status === 'enrolled');
    const bySchoolYear = U.groupBy(enrolled, s => s.schoolYear || CFG.DEFAULT_SCHOOL_YEAR);
    const years = Object.keys(bySchoolYear).sort();
    const currentYear  = years[years.length - 1] || CFG.DEFAULT_SCHOOL_YEAR;
    const previousYear = years.length >= 2 ? years[years.length - 2] : null;
    const nextYear     = bumpSchoolYear(currentYear);

    const current = {};
    const previous = {};
    CFG.GRADE_LEVELS.forEach(g => {
      current[g]  = (bySchoolYear[currentYear]  || []).filter(s => s.gradeLevel === g).length;
      previous[g] = previousYear
        ? (bySchoolYear[previousYear] || []).filter(s => s.gradeLevel === g).length
        : 0;
    });

    const sampleSize = Object.values(current).reduce((s, n) => s + n, 0);
    const hasPriorData = previousYear && Object.values(previous).reduce((s, n) => s + n, 0) >= 5;

    let method, methodNote;
    if (hasPriorData) {
      method = 'year-over-year';
      methodNote =
        'Each grade\'s projection starts from cohort progression (next year\'s Grade N ≈ this year\'s Grade N-1), ' +
        'then is scaled by the year-over-year growth observed in that cohort (clipped to ±30% to dampen small-sample noise). ' +
        'Kindergarten uses YoY growth on the current Kindergarten count itself, since it has no feeder grade. ' +
        `Based on ${years.length} school year${years.length === 1 ? '' : 's'} of records.`;
    } else {
      method = 'cohort-progression';
      methodNote =
        'Each grade\'s projection = current count of the grade immediately below (assumes 100% promotion and no withdrawals). ' +
        'Kindergarten is held flat from the current year. ' +
        'Only one school year of data is available — treat these numbers as a planning baseline, not a forecast.';
    }

    // Compute growth factor per grade cohort. Used by both methods to
    // know how the *current* cohort changed compared to last year.
    function growthOf(grade) {
      if (!hasPriorData || previous[grade] === 0) return 0;
      const raw = (current[grade] - previous[grade]) / previous[grade];
      return Math.max(-0.3, Math.min(0.3, raw));
    }

    const projected = {};
    CFG.GRADE_LEVELS.forEach((g, i) => {
      if (i === 0) {
        // Kindergarten — no feeder grade. Hold flat, or apply YoY growth
        // on itself if we have history.
        projected[g] = method === 'year-over-year'
          ? Math.max(0, Math.round(current[g] * (1 + growthOf(g))))
          : current[g];
      } else {
        const feeder = CFG.GRADE_LEVELS[i - 1];
        const base = current[feeder];
        projected[g] = method === 'year-over-year'
          ? Math.max(0, Math.round(base * (1 + growthOf(feeder))))
          : base;
      }
    });

    return {
      currentYear, previousYear, nextYear,
      current, projected, method, methodNote,
      sampleSize,
      isReliable: sampleSize >= 20 && hasPriorData // honest threshold
    };
  }

  /**
   * Increment a school year string like "2025-2026" → "2026-2027".
   * Falls back to appending "(next)" if the format doesn't match.
   */
  function bumpSchoolYear(sy) {
    const m = /^(\d{4})-(\d{4})$/.exec(String(sy || ''));
    if (!m) return (sy || '') + ' (next)';
    return (parseInt(m[1], 10) + 1) + '-' + (parseInt(m[2], 10) + 1);
  }

  /**
   * Bucket each billed student into On-track / At-risk / Critical
   * based on the proportion of their aged debt to their total billing.
   * Returns { buckets, totals, methodNote }.
   */
  function computeRiskSegmentation(students) {
    const buckets = { onTrack: [], atRisk: [], critical: [] };
    students.forEach(s => {
      const charges = s.charges || [];
      const billed = charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
      if (billed <= 0) return; // never billed, or net discounts — not at risk
      const agedAmount = charges
        .filter(c => c.status !== 'paid' && daysSince(c.createdAt) >= AGED_DAY_THRESHOLD)
        .reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
      const ratio = agedAmount / billed;
      const entry = { student: s, billed, aged: agedAmount, ratio };
      if (agedAmount <= 0)      buckets.onTrack.push(entry);
      else if (ratio < 0.3)     buckets.atRisk.push(entry);
      else                       buckets.critical.push(entry);
    });

    const totalBilledStudents = buckets.onTrack.length + buckets.atRisk.length + buckets.critical.length;
    return {
      buckets,
      totals: {
        students: totalBilledStudents,
        onTrack: buckets.onTrack.length,
        atRisk: buckets.atRisk.length,
        critical: buckets.critical.length,
        atRiskAmount:  buckets.atRisk.reduce((s, r) => s + r.aged, 0),
        criticalAmount: buckets.critical.reduce((s, r) => s + r.aged, 0)
      },
      methodNote:
        `Each billed student is bucketed by aged debt (charges unpaid for ${AGED_DAY_THRESHOLD}+ days) ` +
        'as a fraction of total billing. ' +
        'On-track: no aged debt. At-risk: aged debt is under 30% of billed. ' +
        'Critical: aged debt is 30% or more of billed.'
    };
  }

  /**
   * Where the school's outstanding (unpaid) money lives, by charge type.
   * The same totals broken two ways:
   *   - bySource: keyed by classifyChargeBucket() label
   *   - topTitles: top 5 individual charge titles by outstanding amount
   */
  function computeDiagnosticBreakdown(students) {
    const bySource = {};
    const byTitle = {};
    students.forEach(s => {
      (s.charges || []).forEach(c => {
        if (c.status === 'paid') return;
        const amt = Number(c.amount) || 0;
        if (amt <= 0) return;
        const bucket = classifyChargeBucket(c);
        bySource[bucket] = (bySource[bucket] || 0) + amt;
        const titleKey = c.title.trim().toLowerCase();
        if (!byTitle[titleKey]) byTitle[titleKey] = { name: c.title.trim(), count: 0, amount: 0 };
        byTitle[titleKey].count++;
        byTitle[titleKey].amount += amt;
      });
    });
    const total = Object.values(bySource).reduce((s, n) => s + n, 0);
    const sourceRows = Object.entries(bySource)
      .map(([label, amount]) => ({ label, amount, share: total ? amount / total : 0 }))
      .sort((a, b) => b.amount - a.amount);
    const topTitles = Object.values(byTitle)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
    return {
      sourceRows, topTitles, total,
      methodNote:
        'Aggregates the outstanding (unpaid) balance across every student and groups it by ' +
        'charge type — derived from each charge\'s source, scope, and carry-over flag. ' +
        'Subject placeholders (always 0) and discounts are excluded.'
    };
  }

  /**
   * Recurring-charge patterns. Frames the existing "most common charges"
   * descriptively-→-predictively: a charge that's been billed many times
   * across the school year is *likely* to recur next term.
   */
  function computeRecurringCharges(students) {
    const titleMap = {};
    flattenCharges(students).forEach(({ charge }) => {
      if (charge.source === 'subject' || charge.source === 'discount') return;
      const key = charge.title.trim().toLowerCase();
      if (!titleMap[key]) titleMap[key] = { displayName: charge.title.trim(), count: 0, total: 0 };
      titleMap[key].count += 1;
      titleMap[key].total += Number(charge.amount) || 0;
    });
    return Object.values(titleMap).sort((a, b) => b.count - a.count).slice(0, 6);
  }

  /**
   * Per-grade collection rate (Information-borderline-Diagnostic). Same
   * signal that's been on this page — kept because it's a useful one.
   */
  function computeCollectionByGrade(students) {
    const byGrade = U.groupBy(students, s => s.gradeLevel);
    const rows = [];
    CFG.GRADE_LEVELS.forEach(g => {
      const gs = byGrade[g] || [];
      const charged = gs.reduce((s, st) => s + U.sumCharges(st), 0);
      const paid    = gs.reduce((s, st) => s + U.sumPaidCharges(st), 0);
      if (charged === 0) return;
      rows.push({ grade: g, charged, paid, pct: (paid / charged) * 100 });
    });
    return rows;
  }

  /**
   * One-call rollup used by both Knowledge (display) and Wisdom
   * (recommendations) so the two views always agree.
   */
  function computeAnalytics() {
    const students = Students.getAll();
    const sections = Sections.getAll();
    return {
      students, sections,
      forecast:        computeEnrollmentForecast(students),
      risk:            computeRiskSegmentation(students),
      diagnostic:      computeDiagnosticBreakdown(students),
      recurring:       computeRecurringCharges(students),
      collectionRows:  computeCollectionByGrade(students)
    };
  }

  // ============================================================
  // LAYER 3 — KNOWLEDGE: diagnostic + predictive
  // ============================================================
  function renderKnowledge() {
    const A = computeAnalytics();

    // ----- Diagnostic: Risk Segmentation -----
    renderRiskSegmentation($('#knowledge-risk'), A.risk);
    setMethodologyNote('knowledge-risk-note', A.risk.methodNote);

    // ----- Diagnostic: Outstanding by Type -----
    renderDiagnosticBreakdown($('#knowledge-diagnostic'), A.diagnostic);
    setMethodologyNote('knowledge-diagnostic-note', A.diagnostic.methodNote);

    // ----- Diagnostic: Grade-level collection rate (unchanged signal,
    // now framed as diagnostic) -----
    renderCollectionRate($('#knowledge-rate'), A.collectionRows);

    // ----- Predictive: Enrollment Forecast -----
    renderEnrollmentForecast($('#knowledge-forecast'), A.forecast);
    $('#knowledge-forecast-context').textContent =
      `${A.forecast.currentYear} (actual) → ${A.forecast.nextYear} (projected)` +
      (A.forecast.isReliable ? '' : ' · baseline only');
    setMethodologyNote('knowledge-forecast-note', A.forecast.methodNote);

    // ----- Predictive: Recurring charge patterns -----
    renderRecurringCharges($('#knowledge-charges'), A.recurring);
  }

  function setMethodologyNote(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderRiskSegmentation(host, risk) {
    U.clearNode(host);
    if (risk.totals.students === 0) {
      host.appendChild(U.el('div', { class: 'empty-mini' }, 'No billed students yet — risk segmentation is unavailable until charges are recorded.'));
      return;
    }
    const totalStudents = risk.totals.students;
    const buckets = [
      { key: 'onTrack',  label: 'On-track', count: risk.totals.onTrack,  amount: 0,                            tone: 'good' },
      { key: 'atRisk',   label: 'At-risk',  count: risk.totals.atRisk,   amount: risk.totals.atRiskAmount,     tone: 'warn' },
      { key: 'critical', label: 'Critical', count: risk.totals.critical, amount: risk.totals.criticalAmount,   tone: 'bad'  }
    ];
    buckets.forEach(b => {
      const pct = (b.count / totalStudents) * 100;
      host.appendChild(U.el('div', { class: 'risk-row ' + b.tone }, [
        U.el('div', { class: 'risk-head' }, [
          U.el('span', { class: 'risk-label' }, b.label),
          U.el('span', { class: 'risk-count' }, `${b.count} student${b.count === 1 ? '' : 's'}`)
        ]),
        U.el('div', { class: 'risk-track' }, [U.el('div', { class: 'risk-fill', style: `width:${pct}%;` })]),
        U.el('div', { class: 'risk-foot' }, b.amount > 0
          ? `${U.formatCurrency(b.amount)} aged`
          : (b.key === 'onTrack' && b.count > 0 ? 'No aged debt' : '—')
        )
      ]));
    });
  }

  function renderDiagnosticBreakdown(host, diag) {
    U.clearNode(host);
    if (diag.sourceRows.length === 0) {
      host.appendChild(U.el('div', { class: 'empty-mini' }, 'No outstanding charges — nothing to diagnose.'));
      return;
    }
    host.appendChild(U.el('div', { class: 'diag-summary' },
      `${U.formatCurrency(diag.total)} outstanding across ${diag.sourceRows.length} categor${diag.sourceRows.length === 1 ? 'y' : 'ies'}`));
    diag.sourceRows.forEach(r => {
      host.appendChild(U.el('div', { class: 'diag-row' }, [
        U.el('div', { class: 'diag-label' }, r.label),
        U.el('div', { class: 'diag-bar' }, [U.el('div', { class: 'diag-fill', style: `width:${(r.share * 100).toFixed(1)}%;` })]),
        U.el('div', { class: 'diag-amount' }, U.formatCurrency(r.amount))
      ]));
    });
  }

  function renderCollectionRate(host, rows) {
    U.clearNode(host);
    if (!rows.length) {
      host.appendChild(U.el('div', { class: 'empty-mini' }, 'No billed grades yet.'));
      return;
    }
    rows.forEach(r => {
      host.appendChild(U.el('div', { class: 'bar-row' }, [
        U.el('div', { class: 'lbl' }, r.grade),
        U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill gold', style: `width:${r.pct}%;` })]),
        U.el('div', { class: 'num' }, r.pct.toFixed(0) + '%')
      ]));
    });
  }

  function renderEnrollmentForecast(host, f) {
    U.clearNode(host);
    if (f.sampleSize === 0) {
      host.appendChild(U.el('div', { class: 'empty-mini' }, 'No enrolled students yet — forecast is unavailable.'));
      return;
    }
    // Reliability banner
    const banner = U.el('div', { class: 'forecast-banner ' + (f.isReliable ? 'reliable' : 'baseline') }, [
      U.el('div', { class: 'badge' }, f.isReliable ? 'Forecast' : 'Baseline'),
      U.el('div', { class: 'text' }, f.isReliable
        ? `Year-over-year adjusted projection from ${f.previousYear} → ${f.currentYear} growth.`
        : `Single year of data (${f.currentYear}). Numbers shown are a planning baseline assuming 100% promotion, not a true forecast.`)
    ]);
    host.appendChild(banner);

    // Per-grade chart: two stacked bars (current vs projected).
    const maxVal = Math.max(1, ...CFG.GRADE_LEVELS.map(g => Math.max(f.current[g] || 0, f.projected[g] || 0)));
    CFG.GRADE_LEVELS.forEach(g => {
      const curr = f.current[g] || 0;
      const proj = f.projected[g] || 0;
      if (curr === 0 && proj === 0) return; // hide all-zero grades

      const deltaAbs = proj - curr;
      const deltaPct = curr === 0 ? null : Math.round((deltaAbs / curr) * 100);
      const deltaText = deltaAbs === 0
        ? '±0'
        : (deltaAbs > 0 ? '+' : '') + deltaAbs +
            (deltaPct !== null ? ` (${deltaPct > 0 ? '+' : ''}${deltaPct}%)` : '');
      const deltaTone = deltaAbs > 0 ? 'up' : deltaAbs < 0 ? 'down' : 'flat';

      host.appendChild(U.el('div', { class: 'forecast-row' }, [
        U.el('div', { class: 'forecast-grade' }, g),
        U.el('div', { class: 'forecast-bars' }, [
          U.el('div', { class: 'forecast-bar-line' }, [
            U.el('span', { class: 'series-label current' }, f.currentYear),
            U.el('div', { class: 'series-track' }, [U.el('div', { class: 'series-fill current', style: `width:${(curr / maxVal) * 100}%;` })]),
            U.el('span', { class: 'series-num' }, String(curr))
          ]),
          U.el('div', { class: 'forecast-bar-line' }, [
            U.el('span', { class: 'series-label projected' }, f.nextYear + ' (proj)'),
            U.el('div', { class: 'series-track' }, [U.el('div', { class: 'series-fill projected', style: `width:${(proj / maxVal) * 100}%;` })]),
            U.el('span', { class: 'series-num' }, String(proj))
          ])
        ]),
        U.el('div', { class: 'forecast-delta ' + deltaTone }, deltaText)
      ]));
    });
  }

  function renderRecurringCharges(host, items) {
    U.clearNode(host);
    if (!items.length) {
      host.appendChild(U.el('div', { class: 'empty-mini' }, 'No charges to analyze yet.'));
      return;
    }
    items.forEach(t => {
      host.appendChild(U.el('div', { class: 'row' }, [
        U.el('div', {}, [
          U.el('div', { class: 'ttl' }, t.displayName),
          U.el('div', { class: 'meta' }, `${t.count} occurrence${t.count === 1 ? '' : 's'} · ${U.formatCurrency(t.total)} total billed`)
        ]),
        U.el('div', { class: 'num' }, '×' + t.count)
      ]));
    });
  }

  // ============================================================
  // LAYER 4 — WISDOM: prescriptive, tied back to Knowledge signals
  // ============================================================
  // Every recommendation cites the Knowledge primitive that produced it.
  // This is what makes the D→I→K→W chain visible to the reader instead
  // of recommendations appearing out of thin air.
  function renderWisdom() {
    const grid = $('#wisdom-grid');
    U.clearNode(grid);
    const A = computeAnalytics();
    const insights = [];

    // ----- From Enrollment Forecast: where to add or trim sections -----
    // This is the panelist's direct example: "if you predict increasing
    // enrollment in Grade N, the prescriptive level would recommend
    // opening new sections."
    const forecastGains = [];
    const forecastDrops = [];
    CFG.GRADE_LEVELS.forEach(g => {
      const curr = A.forecast.current[g] || 0;
      const proj = A.forecast.projected[g] || 0;
      if (curr === 0 && proj < 3) return; // ignore noise on empty grades
      const delta = proj - curr;
      if (curr > 0 && (delta / curr) >= 0.2 && delta >= 3) {
        // Capacity check: do existing sections cover the projection?
        const cap = A.sections
          .filter(sec => sec.gradeLevel === g)
          .reduce((s, sec) => s + (sec.capacity || 0), 0);
        forecastGains.push({ grade: g, curr, proj, cap, gap: proj - cap });
      } else if (curr > 0 && (delta / curr) <= -0.2 && Math.abs(delta) >= 3) {
        forecastDrops.push({ grade: g, curr, proj });
      }
    });
    if (forecastGains.length) {
      const overCap = forecastGains.filter(g => g.gap > 0);
      const target = overCap.length ? overCap : forecastGains;
      const list = target.map(g =>
        g.cap > 0
          ? `${g.grade} (projected ${g.proj}, capacity ${g.cap})`
          : `${g.grade} (projected ${g.proj}, no section yet)`
      ).join('; ');
      insights.push({
        layer: 'Section Planning',
        title: 'Plan additional sections for next year',
        body: `Projected growth puts the following grade(s) at or above current section capacity: ${list}. ` +
              'Opening another section preserves the teacher-to-student ratio and signals to families that demand has been accommodated.',
        source: `Knowledge → Enrollment Forecast (${A.forecast.method})`
      });
    }
    if (forecastDrops.length) {
      const list = forecastDrops.map(g => `${g.grade} (${g.curr} → ${g.proj})`).join('; ');
      insights.push({
        layer: 'Section Planning',
        title: 'Re-evaluate sections in shrinking grades',
        body: `Cohort progression projects shrinking enrollment for: ${list}. ` +
              'Consider consolidating sections or reallocating advisers before the new term to avoid under-utilization.',
        source: `Knowledge → Enrollment Forecast (${A.forecast.method})`
      });
    }

    // ----- From Risk Segmentation: collections action -----
    const r = A.risk.totals;
    if (r.critical > 0) {
      insights.push({
        layer: 'Collections',
        title: 'Engage families with critical aged debt',
        body: `${r.critical} student${r.critical === 1 ? '' : 's'} carry critical aged balances totaling ` +
              `${U.formatCurrency(r.criticalAmount)}. Consider direct outreach (call, meeting) and ` +
              'evaluating payment plans before the term advances and balances roll over.',
        source: 'Knowledge → Payment Risk Segmentation (Critical bucket)'
      });
    } else if (r.atRisk >= 3) {
      insights.push({
        layer: 'Collections',
        title: 'Step up reminder cadence',
        body: `${r.atRisk} student${r.atRisk === 1 ? ' is' : 's are'} at-risk with aged balances ` +
              `totaling ${U.formatCurrency(r.atRiskAmount)}. A reminder cadence (SMS at day 7, call at day 14) ` +
              'typically prevents these from drifting into critical territory.',
        source: 'Knowledge → Payment Risk Segmentation (At-risk bucket)'
      });
    } else if (r.students > 0 && r.critical === 0 && r.atRisk === 0) {
      insights.push({
        layer: 'Collections',
        title: 'Collections health is strong',
        body: `All ${r.students} billed student${r.students === 1 ? '' : 's are'} on-track with no aged debt. ` +
              'Maintain the current billing and reminder cadence.',
        source: 'Knowledge → Payment Risk Segmentation (no aged debt)'
      });
    }

    // ----- From Diagnostic Breakdown: where to tighten policy -----
    if (A.diagnostic.total > 0 && A.diagnostic.sourceRows.length) {
      const top = A.diagnostic.sourceRows[0];
      // Only flag if the top category is materially dominant (>40%) and
      // it's a category we can actually do something about. Carry-over
      // and grade-level fees are the typical actionable ones.
      if (top.share >= 0.4 &&
          (top.label.startsWith('Carry-over') || top.label === 'Grade-level fee' || top.label === 'School-wide fee')) {
        let body;
        if (top.label.startsWith('Carry-over')) {
          body = `${(top.share * 100).toFixed(0)}% of all outstanding balance (${U.formatCurrency(top.amount)}) is carry-over from a previous term. ` +
                 'Consider a one-time settlement program or partial-write-off review to prevent these from snowballing further.';
        } else {
          body = `${(top.share * 100).toFixed(0)}% of outstanding balance (${U.formatCurrency(top.amount)}) is concentrated in ${top.label.toLowerCase()}s. ` +
                 'Worth reviewing whether amounts, timing, or communication around these fees can be improved.';
        }
        insights.push({
          layer: 'Fee Policy',
          title: `Address outstanding ${top.label.toLowerCase()}s`,
          body,
          source: `Knowledge → Outstanding by Type (${top.label}: ${(top.share * 100).toFixed(0)}%)`
        });
      }
    }

    // ----- From Recurring Charges: pricing consistency -----
    // Same pricing-pattern check as before, now sourced from the
    // recurring-charges analytic.
    const charges = flattenCharges(A.students).map(x => x.charge);
    if (charges.length >= 3) {
      const titleAmounts = {};
      charges.forEach(c => {
        if (c.source === 'subject' || c.source === 'discount') return;
        const k = c.title.trim().toLowerCase();
        (titleAmounts[k] = titleAmounts[k] || []).push(Number(c.amount) || 0);
      });
      const variants = Object.entries(titleAmounts).filter(([_, arr]) => arr.length >= 2 && new Set(arr).size > 1);
      if (variants.length) {
        const examples = variants.slice(0, 2).map(([k, arr]) => `"${k}" (${[...new Set(arr)].map(U.formatCurrency).join(' / ')})`);
        insights.push({
          layer: 'Fee Standardization',
          title: 'Standardize recurring charges',
          body: `Some recurring fees show inconsistent amounts: ${examples.join(', ')}. ` +
                'Consider standardizing rates to improve transparency and parent trust.',
          source: 'Knowledge → Recurring Charge Patterns'
        });
      }
    }

    // ----- From Information layer: pending approvals backlog -----
    const pending = A.students.filter(s => s.status === 'pending');
    if (pending.length >= 5) {
      const oldestDays = Math.max(...pending.map(s => daysSince(s.createdAt)));
      insights.push({
        layer: 'Enrollment Flow',
        title: 'Clear approval backlog',
        body: `${pending.length} application${pending.length === 1 ? ' is' : 's are'} awaiting approval` +
              (oldestDays > 3 ? `; the oldest has waited ${oldestDays} days` : '') +
              '. Streamlining the registrar-to-admin handoff keeps families informed.',
        source: 'Information → Pending student status'
      });
    }

    // ----- From Section utilisation: consolidation candidates -----
    const underused = A.sections.filter(sec => {
      const assigned = A.students.filter(s => s.section === sec.id).length;
      return sec.capacity > 0 && (assigned / sec.capacity) < 0.4;
    });
    if (underused.length && !forecastGains.length) {
      // Suppress this when a separate "open new sections" recommendation
      // exists for the same year — pulling teachers out of one grade and
      // adding them to another is the same conversation.
      insights.push({
        layer: 'Resource Allocation',
        title: 'Consider consolidating sections',
        body: `${underused.length} section${underused.length === 1 ? '' : 's'} ` +
              `(${underused.slice(0, 3).map(s => s.name).join(', ')}) are filled below 40%. ` +
              'Consolidation could free up adviser capacity for needier grade levels.',
        source: 'Information → Section Utilisation'
      });
    }

    // ----- Default empty state -----
    if (insights.length === 0) {
      insights.push({
        layer: 'Awaiting Data',
        title: 'Not enough activity yet',
        body: 'Once students are enrolled, charges assigned, and payments processed, the system will surface tailored recommendations here. For now, encourage the registrar to begin enrollment.',
        source: null
      });
    }

    insights.forEach(ins => {
      const card = U.el('div', { class: 'insight' }, [
        U.el('div', { class: 'layer' }, ins.layer),
        U.el('h4', {}, ins.title),
        U.el('p', {}, ins.body)
      ]);
      if (ins.source) {
        card.appendChild(U.el('div', { class: 'driven-by' }, [
          U.el('span', { class: 'arrow' }, '→'),
          U.el('span', {}, 'Driven by: '),
          U.el('span', { class: 'src' }, ins.source)
        ]));
      }
      grid.appendChild(card);
    });
  }

  // ----------- Boot -----------
  function init() {
    $('#page-meta').textContent = U.formatDateTime(new Date().toISOString());
    $$('.nav-list button').forEach(btn => btn.addEventListener('click', () => setActiveView(btn.dataset.view)));
    initInformationFilter();
    renderData();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
