/**
 * registrar.js
 * Handles all Registrar workflows. All data ops go through HLC_STORAGE.
 *
 * Required reusable functions per spec:
 *   - addStudent(data)                 → defined here
 *   - updateStatus(studentId, status)  → defined here
 *
 * Scope (academic / enrollment-only)
 * ----------------------------------
 * The registrar owns enrollment, curriculum, and the academic GSA — the
 * "Generated Schedule and Assessment" that lists a student's assigned
 * subjects, applied fee names, section, and status. The registrar does
 * NOT see fee amounts, balances, payment statuses, or transaction history;
 * those live in the cashier module.
 *
 * Data flow:
 *   - Subjects (curriculum) are defined here and assigned to students; each
 *     assignment becomes a zero-amount entry on student.charges with
 *     source:'subject'.
 *   - Misc fees applied to students (school-wide / grade-level / optional)
 *     are managed by the cashier. The registrar's GSA shows them by name
 *     only — never the amount.
 *   - K–10 follows a fixed tuition structure, so subjects do NOT carry
 *     individual fees. School-wide tuition / activity fees are handled
 *     via the cashier's Charges & Fees catalog, which auto-applies on
 *     enrollment via applySchoolWideFees().
 */
(function () {
  'use strict';

  // ----- Auth guard FIRST -----
  const me = window.HLC_AUTH.requireRole('registrar', '../../auth.html');
  if (!me) return;

  const { Students, Subjects, assignSubjectsToStudent, logActivity,
          getActiveSchoolYear, setActiveSchoolYear,
          getKnownSchoolYears, addKnownSchoolYear } = window.HLC_STORAGE;
  const U = window.HLC_UTILS;
  const CFG = window.HLC_CONFIG;
  const $ = U.$, $$ = U.$$;

  // ----- Render shared chrome -----
  window.HLC_LOGO.renderLogo('#sidebar-logo');
  renderUserStrip();

  function renderUserStrip() {
    const host = $('#user-strip');
    host.className = 'user-strip';
    host.innerHTML = `
      <div class="name">${escapeHtml(me.fullName)}</div>
      <div class="email">${escapeHtml(me.email)}</div>
      <button class="logout-btn" id="logout-btn">Sign Out</button>
    `;
    $('#logout-btn').addEventListener('click', () => {
      window.HLC_AUTH.logout();
      window.location.replace('../../auth.html');
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ----------- Reusable domain functions (per spec) -----------

  // The 8 requirement documents — must match the DB enum + enroll.html.
  const ENROLL_DOCS = [
    { type: 'affidavit_of_undertaking', name: 'Affidavit of Undertaking', note: 'PDF or image' },
    { type: 'report_card',             name: 'Report Card',              note: 'PDF or image' },
    { type: 'good_moral',              name: 'Good Moral Certificate',   note: 'PDF or image' },
    { type: 'psa_birth_certificate',   name: 'PSA Birth Certificate',    note: 'Clear scanned copy' },
    { type: 'doctors_advice',          name: "Doctor's Advice",          note: 'If applicable' },
    { type: 'sbt_result',              name: 'SBT Result',               note: 'PDF or image' },
    { type: 'flu_vaccine_certificate', name: 'Flu Vaccine Certificate',  note: 'PDF or image' },
    { type: 'valid_id',                name: 'Valid ID',                 note: 'Parent / guardian ID' }
  ];

  /**
   * Submit a registrar-side enrollment. Unlike the old localStorage path,
   * the rebuilt form has two parents + emergency contact + documents, so it
   * posts to the shared /api/online-enrollment endpoints (the only path that
   * understands guardians and document uploads).
   *
   * A registrar submission is auto-approved right after creation — staff are
   * trusted, unlike anonymous public submissions which stay 'pending'.
   *
   * @param {object} payload — JSON body for /submit
   * @param {File[]} files   — [{type, file}] requirement documents
   * @returns {Promise<object>} the created student record
   */
  async function addStudentOnline(payload, files) {
    // Phase 1 — create the submission.
    const created = await window.HLC_API.post('/api/online-enrollment/submit', payload);

    // Phase 2 — upload any chosen documents (multipart).
    if (files && files.length) {
      const fd = new FormData();
      files.forEach(f => fd.append(f.type, f.file));
      const res = await fetch(
        window.HLC_API.BASE + '/api/online-enrollment/' + created.id + '/documents',
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + window.HLC_API.getToken() },
          body: fd
        }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e.error || 'Document upload failed') +
          ' — the student was created; documents can be added later.');
      }
    }

    // Phase 3 — auto-approve (registrar-entered → trusted).
    await window.HLC_API.post(
      '/api/online-enrollment/submissions/' + created.id + '/approve', {}
    );

    logActivity('registrar', 'student.create',
      `${payload.learner.firstName} ${payload.learner.lastName} ` +
      `(${payload.gradeLevel}) — enrolled at front desk`);
    return created;
  }

  function updateStatus(studentId, status) {
    const updated = Students.update(studentId, { status });
    if (updated) logActivity('registrar', 'student.status', `${updated.firstName} ${updated.lastName} → ${status}`);
    return updated;
  }

  function fullName(s) {
    return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
  }

  // ----------- View routing -----------
  function setActiveView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-list button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    const titles = {
      dashboard: ['Front Desk', 'Dashboard'],
      enroll:    ['New Record', 'Enrollment Form'],
      students:  ['Records', 'Student Directory'],
      schoolyear:['Configuration', 'School Year Management'],
      gsa:       ['Academic', 'Student GSA'],
      subjects:  ['Curriculum', 'Subjects'],
      import:    ['Bulk Operations', 'Bulk Import']
    };
    const [eyebrow, title] = titles[name] || titles.dashboard;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    if (name === 'dashboard')  renderDashboard();
    if (name === 'students')   renderStudentTable();
    if (name === 'schoolyear') renderSchoolYears();
    if (name === 'gsa')        renderGSA();
    if (name === 'subjects')   renderSubjectsList();
    if (name === 'import')     { /* nothing to render; handlers wire on init */ }
  }

  // ----------- Dashboard -----------
  function renderDashboard() {
    const all = Students.getAll();
    const stats = $('#reg-stats');
    U.clearNode(stats);

    const tiles = [
      { label: 'Total Students',   value: all.length },
      { label: 'Pending Approval', value: all.filter(s => s.status === 'pending').length },
      { label: 'Enrolled',         value: all.filter(s => s.status === 'enrolled' || s.status === 'approved').length, gold: true },
      { label: 'Subjects in Catalog', value: Subjects.getAll().length }
    ];
    tiles.forEach(t => {
      const node = U.el('div', { class: 'stat' + (t.gold ? ' gold' : '') }, [
        U.el('div', { class: 'label' }, t.label),
        U.el('div', { class: 'value' }, String(t.value))
      ]);
      stats.appendChild(node);
    });

    const recent = all.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    const host = $('#recent-enrollments');
    U.clearNode(host);
    if (!recent.length) {
      host.appendChild(emptyState('No enrollments yet', 'Use “New Enrollment” to add the first student.'));
      return;
    }
    recent.forEach(s => {
      host.appendChild(U.el('div', { class: 'recent-row' }, [
        U.el('div', { class: 'name' }, fullName(s)),
        U.el('div', { class: 'grade' }, s.gradeLevel),
        statusPill(s.status),
        U.el('div', { class: 'when' }, U.formatDate(s.createdAt))
      ]));
    });
  }

  function statusPill(status) {
    return U.el('span', { class: 'pill pill-' + status }, status);
  }

  function emptyState(title, msg) {
    return U.el('div', { class: 'empty' }, [
      U.el('div', { class: 'ico' }, '✦'),
      U.el('div', { class: 'title' }, title),
      U.el('div', {}, msg)
    ]);
  }

  // ----------- Enrollment form -----------
  function initEnrollForm() {
    // Grade level options.
    const grade = $('#gradeLevel');
    CFG.GRADE_LEVELS.forEach(g => grade.appendChild(U.el('option', { value: g }, g)));

    // School Year options — populated from the centrally-managed list, with
    // the active school year preselected as the default.
    const syField = $('#schoolYear');
    const active = getActiveSchoolYear();
    U.clearNode(syField);
    getKnownSchoolYears().forEach(sy => {
      syField.appendChild(U.el('option',
        { value: sy, selected: sy === active }, sy));
    });

    // Default enrollment date to today.
    $('#enrollmentDate').value = new Date().toISOString().slice(0, 10);

    // Build the 8 document upload tiles.
    const docBox = $('#enroll-docs');
    ENROLL_DOCS.forEach(d => {
      const tile = U.el('div', { class: 'doc-tile', 'data-type': d.type });
      tile.innerHTML =
        '<span class="dt-name">' + d.name + '</span>' +
        '<span class="dt-note">' + d.note + '</span>' +
        '<input type="file" accept="application/pdf,image/*" data-doc="' + d.type + '">';
      docBox.appendChild(tile);
    });
    docBox.addEventListener('change', e => {
      if (e.target.type !== 'file') return;
      e.target.closest('.doc-tile').classList.toggle('filled', !!e.target.files[0]);
    });

    // Age auto-computes from date of birth.
    $('#l_birthDate').addEventListener('change', function () {
      const out = $('#l_age');
      if (!this.value) { out.value = ''; return; }
      const dob = new Date(this.value), now = new Date();
      let age = now.getFullYear() - dob.getFullYear();
      const m = now.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
      out.value = age >= 0 ? age : '';
    });

    // Shuttle service conditional fields.
    $('#shuttleService').addEventListener('change', function () {
      $('#shuttleFields').hidden = !this.checked;
    });

    $('#enroll-form').addEventListener('submit', onEnrollSubmit);
  }

  function enrollErr(msg) {
    const box = $('#enroll-error');
    box.textContent = msg;
    box.classList.add('show');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function onEnrollSubmit(e) {
    e.preventDefault();
    $('#enroll-error').classList.remove('show');
    const v = id => ($('#' + id).value || '').trim();

    // ── Required-field checks (mirror the server + the public form) ──
    const required = {
      enrollmentDate: 'Enrollment Date', schoolYear: 'School Year',
      program: 'Program', gradeLevel: 'Grade Level',
      l_lastName: 'Learner Last Name', l_firstName: 'Learner First Name',
      l_birthDate: 'Date of Birth', l_gender: 'Gender',
      e_fullName: 'Emergency Contact Name',
      e_relationship: 'Emergency Contact Relationship',
      e_mobile: 'Emergency Contact Mobile', e_address: 'Emergency Contact Address'
    };
    for (const k in required) {
      if (!v(k)) { enrollErr('Please fill in: ' + required[k]); return; }
    }
    if ($('#shuttleService').checked && !v('carpoolService')) {
      enrollErr('Carpool Service is required when Shuttle Service is on.');
      return;
    }

    // ── At least one parent ──
    const parentFilled = p => ['lastName', 'firstName', 'address', 'mobile']
      .some(f => v(p + '_' + f));
    const fT = parentFilled('f'), mT = parentFilled('m');
    if (!fT && !mT) {
      enrollErr("Please provide at least one parent's information (Father or Mother).");
      return;
    }
    // If a parent block is started, its key fields are required.
    for (const [p, touched] of [['f', fT], ['m', mT]]) {
      if (!touched) continue;
      for (const f of ['lastName', 'firstName', 'address', 'mobile']) {
        if (!v(p + '_' + f)) {
          enrollErr('Please complete the ' + (p === 'f' ? "Father" : "Mother") +
            "'s information, or clear it entirely.");
          return;
        }
      }
    }

    // ── Build the payload (same shape the online form posts) ──
    const parentObj = p => ({
      lastName: v(p + '_lastName'), firstName: v(p + '_firstName'),
      middleName: v(p + '_middleName'), homeAddress: v(p + '_address'),
      religion: v(p + '_religion'), mobileNumber: v(p + '_mobile'),
      telephoneNumber: v(p + '_tel')
    });
    const payload = {
      schoolYear: v('schoolYear'), program: v('program'),
      gradeLevel: v('gradeLevel'), enrollmentDate: v('enrollmentDate'),
      learner: {
        lastName: v('l_lastName'), firstName: v('l_firstName'),
        middleName: v('l_middleName'), birthDate: v('l_birthDate'),
        gender: v('l_gender'), schoolLastAttended: v('l_school')
      },
      other: {
        shuttleService: $('#shuttleService').checked,
        carpoolService: v('carpoolService'),
        escGrantee: $('#escGrantee').checked
      },
      emergency: {
        fullName: v('e_fullName'), mobileNumber: v('e_mobile'),
        relationship: v('e_relationship'), homeAddress: v('e_address')
      }
    };
    if (fT) payload.father = parentObj('f');
    if (mT) payload.mother = parentObj('m');

    // ── Collect documents ──
    const files = [];
    $$('#enroll-docs input[type=file]').forEach(inp => {
      if (inp.files && inp.files[0]) {
        files.push({ type: inp.dataset.doc, file: inp.files[0] });
      }
    });

    // ── Submit ──
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const created = await addStudentOnline(payload, files);
      U.toast('Enrolled: ' + payload.learner.firstName + ' ' +
        payload.learner.lastName, 'success');
      e.target.reset();
      $('#enroll-docs').querySelectorAll('.doc-tile').forEach(t =>
        t.classList.remove('filled'));
      // Refresh the cache so the new student shows in Records when the
      // registrar opens that view next. We deliberately stay on the Enroll
      // form (no setActiveView call) so the registrar isn't bounced away
      // right after submitting — they may want to enroll another learner.
      if (window.HLC_STORAGE && window.HLC_STORAGE.bootstrap) {
        await window.HLC_STORAGE.bootstrap();
      }
      // Restore the default enrollment date that was cleared by .reset().
      $('#enrollmentDate').value = new Date().toISOString().slice(0, 10);
    } catch (err) {
      enrollErr(err && err.message ? err.message :
        'Enrollment failed. Please try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Submit Enrollment';
    }
  }

  // ----------- Student table -----------
  function renderStudentTable(filter) {
    const tbody = $('#students-tbl tbody');
    U.clearNode(tbody);
    const all = Students.getAll();
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? all : all.filter(s =>
      fullName(s).toLowerCase().includes(f) ||
      (s.id || '').toLowerCase().includes(f) ||
      (s.gradeLevel || '').toLowerCase().includes(f) ||
      (s.program || '').toLowerCase().includes(f) ||
      (s.status || '').toLowerCase().includes(f) ||
      (s.guardianName || '').toLowerCase().includes(f)
    );

    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.appendChild(emptyState('No students found', f ? 'Try a different search term.' : 'Add your first student through New Enrollment.'));
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).forEach(s => {
      const tr = document.createElement('tr');
      // Student No. — the database id, shown monospaced so it's easy to read.
      tr.appendChild(U.el('td', {
        style: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
               'font-size:0.82rem;color:var(--ink-700);white-space:nowrap;'
      }, s.id));
      // Student — name + a small "Online" tag for online-sourced records.
      const nameCell = [
        U.el('div', { style: 'font-weight:500;color:var(--ink-900);' }, fullName(s)),
        U.el('div', { style: 'font-size:0.78rem;color:var(--ink-500);' }, s.gender + ' · ' + U.formatDate(s.birthDate))
      ];
      if (s.enrollmentSource === 'online') {
        nameCell.push(U.el('span', {
          style: 'display:inline-block;margin-top:3px;font-size:0.66rem;' +
            'font-weight:600;color:var(--maroon-700,#6b1f23);' +
            'background:var(--maroon-100,#f7ebec);border-radius:4px;padding:1px 6px;'
        }, 'ONLINE'));
      }
      tr.appendChild(U.el('td', {}, nameCell));
      tr.appendChild(U.el('td', {}, s.gradeLevel));
      tr.appendChild(U.el('td', {}, s.program || '—'));
      tr.appendChild(U.el('td', {}, [
        U.el('div', {}, s.guardianName || '—'),
        U.el('div', { style: 'font-size:0.78rem;color:var(--ink-500);' }, s.contact || '')
      ]));
      const statusTd = document.createElement('td');
      statusTd.appendChild(statusPill(s.status));
      // If the registrar has approved-in-principle but required documents
      // are still missing, surface the intent under the main status pill.
      if (s.pendingApproval && s.status === 'pending') {
        statusTd.appendChild(U.el('div', {
          style: 'display:inline-block;margin-top:4px;font-size:0.66rem;' +
                 'font-weight:600;color:var(--maroon-700,#6b1f23);' +
                 'background:var(--gold-100,#f8f0d4);border-radius:4px;' +
                 'padding:1px 6px;letter-spacing:0.02em;'
        }, 'AWAITING DOCS'));
      }
      tr.appendChild(statusTd);
      tr.appendChild(U.el('td', {}, U.formatDate(s.createdAt)));

      const actions = U.el('td', { class: 'actions' });
      actions.appendChild(U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openStudentModal(s.id) }, 'View'));
      actions.appendChild(U.el('button', {
        class: 'btn btn-accent btn-sm',
        style: 'margin-left:6px;',
        onclick: () => openAssignModal(s.id)
      }, 'Assign Subjects'));
      actions.appendChild(U.el('button', {
        class: 'btn btn-ghost btn-sm',
        style: 'margin-left:6px;',
        onclick: () => openGradeChangeModal(s.id)
      }, 'Change Grade'));
      actions.appendChild(U.el('button', {
        class: 'btn btn-primary btn-sm',
        style: 'margin-left:6px;',
        onclick: () => openEditStudentModal(s.id)
      }, 'Edit'));
      actions.appendChild(U.el('button', {
        class: 'btn btn-danger btn-sm',
        style: 'margin-left:6px;',
        onclick: () => openDeleteStudentModal(s.id)
      }, 'Delete'));
      if (s.status === 'pending') {
        // The button text reflects what the click will actually do, so the
        // registrar isn't surprised when "Approve" doesn't flip the badge.
        // If pendingApproval is already set, the intent has been recorded
        // and we're waiting on documents; clicking it again is a no-op
        // (the backend keeps it idempotent).
        const label = s.pendingApproval ? 'Awaiting Documents' : 'Approve';
        const isAlreadyMarked = !!s.pendingApproval;
        actions.appendChild(U.el('button', {
          class: 'btn btn-primary btn-sm',
          style: 'margin-left:6px;' + (isAlreadyMarked ? 'opacity:0.7;' : ''),
          onclick: async () => {
            const updated = updateStatus(s.id, 'approved');
            // Re-fetch from the server so the response reflects the
            // two-phase gate (status may stay 'pending' with
            // pendingApproval=1 if required documents are still missing).
            if (window.HLC_STORAGE && window.HLC_STORAGE.bootstrap) {
              try { await window.HLC_STORAGE.bootstrap(); } catch (_) { /* best-effort */ }
            }
            const after = Students.getById(s.id) || updated || {};
            if (after.status === 'approved' || after.status === 'enrolled') {
              U.toast('Marked as approved', 'success');
            } else if (after.pendingApproval) {
              U.toast('Approval saved — waiting on required documents', 'info');
            } else {
              U.toast('Status updated', 'success');
            }
            renderStudentTable($('#students-search').value);
            renderDashboard();
          }
        }, label));
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  // ----------- Student modal -----------
  function openStudentModal(studentId) {
    const s = Students.getById(studentId);
    if (!s) return;
    $('#sm-name').textContent = fullName(s);
    const body = $('#sm-body');
    U.clearNode(body);

    // ── Core detail grid — now includes the online-enrollment fields when
    //    present. Walk-in students enrolled before migration 002 simply
    //    show "—" for the new fields; nothing breaks. ──
    const grid = U.el('div', { class: 'detail-grid' });
    const fields = [
      ['Grade Level', s.gradeLevel],
      ['Status',      s.status],
      ['Program',     s.program],
      ['School Year', s.schoolYear],
      ['Birth Date',  U.formatDate(s.birthDate)],
      ['Age',         computeAgeFrom(s.birthDate)],
      ['Gender',      s.gender],
      ['School Last Attended', s.schoolLastAttended],
      ['Enrollment Source', s.enrollmentSource === 'online' ? 'Online' : 'Walk-in'],
      ['Enrollment Date',   U.formatDate(s.enrollmentDate)],
      ['Shuttle Service',   s.shuttleService ? 'Yes' : 'No'],
      ['Carpool Service',   s.shuttleService ? labelCarpool(s.carpoolService) : ''],
      ['ESC Grantee',       s.escGrantee ? 'Yes' : 'No'],
      ['Guardian (summary)', s.guardianName],
      ['Contact (summary)',  s.contact],
      ['Section',            s.section || '— Not assigned —']
    ];
    fields.forEach(([k, v]) => {
      grid.appendChild(U.el('div', {}, [
        U.el('div', { class: 'lbl' }, k),
        U.el('div', { class: 'val' }, (v === 0 || v) ? String(v) : '—')
      ]));
    });
    body.appendChild(grid);

    if (s.notes) {
      body.appendChild(U.el('div', { class: 'lbl' }, 'Notes'));
      body.appendChild(U.el('div', { style: 'margin-bottom:18px;font-size:0.92rem;color:var(--ink-700);' }, s.notes));
    }

    // ── Parents / emergency contact / documents — these live in separate
    //    tables, so we fetch the fully-hydrated record on demand from the
    //    online-enrollment endpoint. A placeholder shows while it loads. ──
    const extra = U.el('div', { id: 'sm-extra' }, [
      U.el('div', { style: 'font-size:0.85rem;color:var(--ink-500);padding:8px 0;' },
        'Loading family & document details…')
    ]);
    body.appendChild(extra);
    loadStudentExtras(studentId, extra);

    // ── Academic mini-panel (unchanged — curriculum & applied fees) ──
    const mini = U.el('div', { class: 'charges-mini' });
    const subjectEntries = (s.charges || []).filter(c => c.source === 'subject');
    const feeEntries     = (s.charges || []).filter(c => c.source !== 'subject');

    mini.appendChild(U.el('h4', {}, `Curriculum & Applied Items (${(s.charges || []).length})`));
    if (!s.charges || !s.charges.length) {
      mini.appendChild(U.el('div', { style: 'font-size:0.85rem;color:var(--ink-500);' }, 'No subjects assigned and no fees applied yet.'));
    } else {
      if (subjectEntries.length) {
        mini.appendChild(U.el('div', { class: 'charge-group-label' }, 'Subjects'));
        subjectEntries.forEach(c => {
          const left = U.el('div', { class: 'charge-title' }, c.title);
          mini.appendChild(U.el('div', { class: 'charge-row charge-row-academic' }, [left]));
        });
      }
      if (feeEntries.length) {
        mini.appendChild(U.el('div', { class: 'charge-group-label' }, 'Applied fees'));
        feeEntries.forEach(c => {
          const desc = c.description ? U.el('div', { class: 'charge-desc' }, c.description) : null;
          const titleRow = U.el('div', { class: 'charge-title' }, c.title);
          const left = U.el('div', {}, [titleRow, desc].filter(Boolean));
          mini.appendChild(U.el('div', { class: 'charge-row charge-row-academic' }, [left]));
        });
      }
    }
    body.appendChild(mini);

    $('#student-modal').classList.add('open');
  }

  // Compute age from a 'YYYY-MM-DD' birth date string.
  function computeAgeFrom(birthDate) {
    if (!birthDate) return '';
    const dob = new Date(birthDate);
    if (isNaN(dob.getTime())) return '';
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    return age >= 0 ? age : '';
  }

  function labelCarpool(v) {
    return ({ none: 'Round Trip', morning: 'One-Way — Morning',
      afternoon: 'One-Way — Afternoon' })[v] || (v || '');
  }

  // Document-type code → human label (matches the 8 requirement documents).
  const DOC_LABELS = {
    affidavit_of_undertaking: 'Affidavit of Undertaking',
    report_card: 'Report Card', good_moral: 'Good Moral Certificate',
    psa_birth_certificate: 'PSA Birth Certificate',
    doctors_advice: "Doctor's Advice", sbt_result: 'SBT Result',
    flu_vaccine_certificate: 'Flu Vaccine Certificate', valid_id: 'Valid ID'
  };

  /**
   * Fetch the fully-hydrated record (parents + emergency contact +
   * documents) and render it into `host`. Safe for walk-in students too —
   * the endpoint returns empty guardians/documents and we show a note.
   */
  async function loadStudentExtras(studentId, host) {
    try {
      const full = await window.HLC_API.get(
        '/api/online-enrollment/submissions/' + studentId);
      U.clearNode(host);

      // Parents + emergency contact.
      const people = [
        ['Father', full.father], ['Mother', full.mother],
        ['Emergency Contact', full.emergency]
      ].filter(p => p[1]);

      if (people.length) {
        host.appendChild(U.el('h4', { style: 'margin:14px 0 6px;' },
          'Family & Emergency Contact'));
        people.forEach(([label, g]) => {
          const name = g.fullName ||
            [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' ');
          const rows = [
            ['Name', name], ['Relationship', g.relationship],
            ['Mobile', g.mobileNumber], ['Telephone', g.telephoneNumber],
            ['Home Address', g.homeAddress], ['Religion', g.religion]
          ].filter(r => r[1]);
          const grid = U.el('div', { class: 'detail-grid' });
          rows.forEach(([k, v]) => grid.appendChild(U.el('div', {}, [
            U.el('div', { class: 'lbl' }, k),
            U.el('div', { class: 'val' }, v)
          ])));
          host.appendChild(U.el('div', { class: 'charge-group-label' }, label));
          host.appendChild(grid);
        });
      }

      // Uploaded documents.
      host.appendChild(U.el('h4', { style: 'margin:14px 0 6px;' },
        `Documents (${(full.documents || []).length})`));
      if (!full.documents || !full.documents.length) {
        host.appendChild(U.el('div',
          { style: 'font-size:0.85rem;color:var(--ink-500);' },
          'No documents uploaded.'));
      } else {
        const list = U.el('div', { class: 'doc-list' });
        full.documents.forEach(d => {
          // The backend's download route is auth-protected. A plain
          // <a href> link would navigate the browser there without
          // attaching the JWT (which lives in localStorage, not a
          // cookie), so we'd get "Missing or malformed Authorization
          // header". Instead, intercept the click, fetch the file with
          // the Authorization header, convert to a blob URL, and open
          // THAT in a new tab. The blob URL is local to the browser, no
          // auth needed.
          const a = U.el('a', {
            href: '#', class: 'doc-link'
          }, (DOC_LABELS[d.documentType] || d.documentType) +
             ' — ' + d.originalName);
          a.addEventListener('click', async (ev) => {
            ev.preventDefault();
            try {
              const res = await fetch(window.HLC_API.BASE + d.url, {
                headers: { 'Authorization': 'Bearer ' + window.HLC_API.getToken() }
              });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const blob = await res.blob();
              const blobUrl = URL.createObjectURL(blob);
              // Open in a new tab. Revoke the URL after a beat so it
              // doesn't leak memory; the new tab caches the bytes.
              window.open(blobUrl, '_blank', 'noopener');
              setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
            } catch (err) {
              U.toast('Could not open document: ' +
                      (err.message || 'unknown error'), 'error');
            }
          });
          list.appendChild(a);
        });
        host.appendChild(list);
      }
    } catch (err) {
      U.clearNode(host);
      host.appendChild(U.el('div',
        { style: 'font-size:0.82rem;color:var(--ink-500);' },
        'Family & document details unavailable.'));
    }
  }

  function closeModal() { $('#student-modal').classList.remove('open'); }

  // ----------- School Year management -----------
  function renderSchoolYears() {
    const active = getActiveSchoolYear();
    $('#sy-active-label').textContent = active;

    const tbody = $('#sy-tbl tbody');
    U.clearNode(tbody);
    const years = getKnownSchoolYears();

    if (!years.length) {
      const tr = document.createElement('tr');
      const td = U.el('td', { colspan: 3 });
      td.appendChild(emptyState('No school years yet',
        'Add your first school year above.'));
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    years.forEach(sy => {
      const isActive = sy === active;
      const tr = document.createElement('tr');
      tr.appendChild(U.el('td', { style: 'font-weight:500;' }, sy));

      const statusTd = document.createElement('td');
      statusTd.appendChild(U.el('span', {
        class: 'pill ' + (isActive ? 'pill-approved' : 'pill-pending')
      }, isActive ? 'Active' : 'Inactive'));
      tr.appendChild(statusTd);

      const actionTd = U.el('td', { class: 'actions' });
      if (isActive) {
        actionTd.appendChild(U.el('span',
          { style: 'font-size:0.8rem;color:var(--ink-500);' },
          'Current default'));
      } else {
        actionTd.appendChild(U.el('button', {
          class: 'btn btn-primary btn-sm',
          onclick: () => makeSchoolYearActive(sy)
        }, 'Set as Active'));
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  }

  function makeSchoolYearActive(sy) {
    setActiveSchoolYear(sy);
    logActivity('registrar', 'settings.activeSchoolYear',
      `Active school year set to ${sy}`);
    U.toast(`Active school year is now ${sy}`, 'success');
    renderSchoolYears();
  }

  // Accepts "2026-2027" or "2026–2027" (en-dash); stores canonical hyphen form.
  function normalizeSchoolYear(raw) {
    const s = String(raw || '').trim().replace(/\u2013|\u2014/g, '-');
    const m = s.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (!m) return null;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (b !== a + 1) return null;          // must be consecutive years
    return `${a}-${b}`;
  }

  function initSchoolYearForm() {
    $('#sy-add-form').addEventListener('submit', e => {
      e.preventDefault();
      const raw = $('#sy-input').value;
      const sy = normalizeSchoolYear(raw);
      if (!sy) {
        U.toast('Enter a valid school year, e.g. 2026-2027 ' +
          '(two consecutive years).', 'error');
        return;
      }
      if (getKnownSchoolYears().indexOf(sy) !== -1) {
        U.toast(`${sy} is already in the list.`, 'error');
        return;
      }
      addKnownSchoolYear(sy);
      logActivity('registrar', 'settings.schoolYear', `Added school year ${sy}`);
      U.toast(`Added school year ${sy}`, 'success');
      $('#sy-input').value = '';
      renderSchoolYears();
    });
  }

  // ----------- Student GSA (academic schedule & assessment) -----------
  // Registrar-side GSA: shows the curriculum and any fees applied to a student
  // by NAME ONLY. Amounts, balances, payment status, and transaction history
  // are intentionally absent — those live in the cashier module. The data
  // source is the same student.charges[] array; we simply omit the monetary
  // fields when rendering.
  function renderGSA(filter) {
    const host = $('#gsa-grid');
    U.clearNode(host);

    // Show every student that has either an enrolled status OR any curriculum/fee
    // entry on file. We don't filter purely on charges.length because a freshly
    // enrolled student may still be awaiting subject assignment.
    const all = Students.getAll().filter(s =>
      (Array.isArray(s.charges) && s.charges.length > 0) ||
      s.status === 'approved' || s.status === 'enrolled'
    );
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? all : all.filter(s =>
      fullName(s).toLowerCase().includes(f) ||
      (s.gradeLevel || '').toLowerCase().includes(f) ||
      (s.status || '').toLowerCase().includes(f)
    );

    if (!list.length) {
      host.appendChild(U.el('div', { class: 'empty' }, [
        U.el('div', { class: 'ico' }, '✦'),
        U.el('div', { class: 'title' }, f ? 'No matching students' : 'No active GSAs yet'),
        U.el('div', {}, f ? 'Try a different search.' : 'Once a student is enrolled and assigned subjects, their GSA appears here.')
      ]));
      return;
    }

    list.sort((a, b) => fullName(a).localeCompare(fullName(b))).forEach(s => {
      host.appendChild(buildAcademicGSACard(s.id));
    });
  }

  function buildAcademicGSACard(studentId, options) {
    options = options || {};
    const student = Students.getById(studentId);
    if (!student) return document.createElement('div');

    // Group charge entries by source — we only display titles, never amounts.
    // Carry-over entries from prior promotions are pulled out into their own
    // section below so they don't visually mix with the new grade's items.
    const charges = student.charges || [];
    const activeCharges = charges.filter(c => !c.isCarryOver && c.source !== 'discount');
    const carryOverEntries = charges.filter(c => c.isCarryOver);

    const subjectEntries = activeCharges.filter(c => c.source === 'subject');
    const schoolWideEntries = activeCharges.filter(c => c.source === 'misc-fee' && c.feeScope === 'school');
    const gradeLevelEntries = activeCharges.filter(c => c.source === 'misc-fee' && c.feeScope === 'grades');
    const optionalEntries = activeCharges.filter(c => c.source === 'misc-fee' && c.feeScope === 'optional');
    const otherEntries = activeCharges.filter(c =>
      c.source !== 'subject' && c.source !== 'misc-fee'
    );

    const sectionLabel = student.section
      ? (window.HLC_STORAGE.Sections.getById(student.section) || {}).name || '— Unassigned —'
      : '— Unassigned —';

    // Persist expand/collapse like the cashier version did.
    const persistKey = 'hlc_reg_gsa_open_' + studentId;
    let initiallyOpen = options.open;
    if (initiallyOpen === undefined) {
      const stored = localStorage.getItem(persistKey);
      initiallyOpen = stored === '1';
    }

    const detailsAttrs = { class: 'gsa-card gsa-rich gsa-collapsible' };
    if (initiallyOpen) detailsAttrs.open = '';
    const card = U.el('details', detailsAttrs);
    card.addEventListener('toggle', () => {
      try { localStorage.setItem(persistKey, card.open ? '1' : '0'); } catch (e) {}
    });

    // ----- SUMMARY -----
    const summary = U.el('summary', { class: 'gsa-summary' });
    const chevron = U.el('span', { class: 'chev', 'aria-hidden': 'true' }, '▸');
    const idText = U.el('span', { class: 'sum-id' }, '#' + student.id.replace(/^stu_/, '').toUpperCase());
    const nameBlock = U.el('div', { class: 'sum-name-block' }, [
      U.el('div', { class: 'sum-name' }, fullName(student)),
      U.el('div', { class: 'sum-meta' }, `${student.gradeLevel} · ${student.guardianName || '—'}`)
    ]);
    const statusPill = U.el('span', { class: 'pill pill-' + student.status }, student.status);
    // Right-side block: subject count instead of a balance amount.
    const acadBlock = U.el('div', { class: 'sum-balance' }, [
      U.el('div', { class: 'sum-balance-lbl' }, 'Subjects'),
      U.el('div', { class: 'sum-balance-val zero' }, String(subjectEntries.length))
    ]);

    summary.appendChild(chevron);
    summary.appendChild(nameBlock);
    summary.appendChild(idText);
    summary.appendChild(statusPill);
    summary.appendChild(acadBlock);
    card.appendChild(summary);

    // ----- HEAD -----
    const head = U.el('div', { class: 'gsa-doc-head' }, [
      U.el('div', { class: 'title-block' }, [
        U.el('div', { class: 'doc-eyebrow' }, 'Generated Schedule and Assessment'),
        U.el('h3', { class: 'student-name' }, fullName(student)),
        U.el('div', { class: 'student-meta' }, [
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Student #'), student.id.replace(/^stu_/, '').toUpperCase()]),
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Grade'),     student.gradeLevel]),
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Section'),   sectionLabel]),
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'School Year'), student.schoolYear || '—']),
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Guardian'),  student.guardianName || '—']),
          U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Contact'),   student.contact || '—'])
        ])
      ]),
      U.el('div', { class: 'status-block' }, [
        U.el('span', { class: 'pill pill-' + student.status, style: 'font-size:0.78rem; padding:4px 12px;' }, student.status),
        U.el('div', { class: 'gen-date' }, 'Generated ' + U.formatDate(new Date().toISOString()))
      ])
    ]);
    card.appendChild(head);

    // ----- BODY -----
    const body = U.el('div', { class: 'gsa-body' });
    body.appendChild(buildAcademicSection('Subjects',          subjectEntries,    'No subjects assigned yet.'));
    body.appendChild(buildAcademicSection('School-wide Fees',  schoolWideEntries, 'No school-wide fees applied.'));
    if (gradeLevelEntries.length) {
      body.appendChild(buildAcademicSection('Grade-level Fees', gradeLevelEntries, 'None'));
    }
    if (optionalEntries.length) {
      body.appendChild(buildAcademicSection('Optional Fees',   optionalEntries,   'None'));
    }
    if (otherEntries.length) {
      body.appendChild(buildAcademicSection('Other Items',     otherEntries,      'None'));
    }
    if (carryOverEntries.length) {
      body.appendChild(buildCarryOverSection(carryOverEntries));
    }
    card.appendChild(body);

    // ----- FOOTER -----
    const foot = U.el('div', { class: 'gsa-doc-foot' }, [
      U.el('div', { class: 'processed-by' }, [
        U.el('div', {}, 'Prepared by'),
        U.el('div', { class: 'name' }, me ? me.fullName : '—')
      ]),
      U.el('div', {}, 'HLC · Form-RA-01-00')
    ]);
    card.appendChild(foot);

    // ----- ACTIONS -----
    const actions = U.el('div', { class: 'gsa-actions-rich' });
    actions.appendChild(U.el('button', {
      class: 'btn btn-accent btn-sm',
      onclick: (e) => { e.stopPropagation(); openAssignModal(student.id); }
    }, 'Assign Subjects'));
    actions.appendChild(U.el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: (e) => { e.stopPropagation(); printAcademicGSA(student.id); }
    }, 'Print'));
    card.appendChild(actions);

    return card;
  }

  /**
   * Render an academic GSA section: titles only, no amounts or payment status.
   * The shared `gsa-line` styling is reused, but we add `gsa-line-academic`
   * so the layout collapses cleanly without the right-side amount cell.
   */
  function buildAcademicSection(heading, entries, emptyMsg) {
    const sec = U.el('div', { class: 'gsa-rich-section' });
    sec.appendChild(U.el('h5', {}, [
      U.el('span', {}, heading),
      U.el('span', { class: 'subtotal subtotal-count' }, entries.length ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : '')
    ]));
    if (!entries.length) {
      sec.appendChild(U.el('div', { class: 'gsa-empty-line' }, emptyMsg));
      return sec;
    }
    entries.forEach(c => {
      sec.appendChild(U.el('div', { class: 'gsa-line gsa-line-academic' }, [
        U.el('div', { class: 'lbl-block' }, [
          U.el('div', { class: 'lbl' }, c.title),
          c.category ? U.el('div', { class: 'lbl-cat' }, c.category)
                     : (c.description ? U.el('div', { class: 'lbl-cat' }, c.description) : null)
        ].filter(Boolean))
      ]));
    });
    return sec;
  }

  /**
   * Render a "Previous Term — Unsettled" section listing carry-over items
   * by name, grouped by their original grade/school year. We never show
   * amounts here — financial figures stay in the cashier module.
   */
  function buildCarryOverSection(entries) {
    const sec = U.el('div', { class: 'gsa-rich-section gsa-carry-section' });
    sec.appendChild(U.el('h5', {}, [
      U.el('span', {}, 'Previous Term — Unsettled'),
      U.el('span', { class: 'subtotal subtotal-count' }, `${entries.length} item${entries.length === 1 ? '' : 's'}`)
    ]));

    // Group by "Grade · SY" so a student promoted twice with leftover items
    // from each term reads cleanly.
    const groups = {};
    entries.forEach(c => {
      const key = `${c.originalGradeLevel || '—'} · ${c.originalSchoolYear || '—'}`;
      (groups[key] = groups[key] || []).push(c);
    });

    Object.keys(groups).sort().forEach(key => {
      sec.appendChild(U.el('div', { class: 'gsa-carry-group-label' }, key));
      groups[key].forEach(c => {
        sec.appendChild(U.el('div', { class: 'gsa-line gsa-line-academic gsa-line-carry' }, [
          U.el('div', { class: 'lbl-block' }, [
            U.el('div', { class: 'lbl' }, c.title),
            U.el('div', { class: 'lbl-cat' }, 'Outstanding from previous term — see cashier')
          ])
        ]));
      });
    });
    return sec;
  }

  /**
   * Print-friendly window for the academic GSA. Mirrors the cashier's old
   * print flow but renders the registrar's amount-free version of the card.
   */
  function printAcademicGSA(studentId) {
    const card = buildAcademicGSACard(studentId, { open: true });
    const student = Students.getById(studentId);
    if (!student) {
      U.toast('Could not generate GSA for this student', 'error');
      return;
    }
    const studentName = fullName(student);
    const cssUrl = new URL('../../assets/css/shared.css', window.location.href).href;

    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) {
      U.toast('Pop-up blocked — please allow pop-ups to print', 'error');
      return;
    }

    w.document.open();
    w.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>GSA · ${escapeHtml(studentName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${cssUrl}">
  <style>
    body { background: var(--paper); padding: 32px; max-width: 820px; margin: 0 auto; }
    .gsa-actions-rich { display: none !important; }
    @media print {
      body { padding: 0; max-width: none; }
      .gsa-card.gsa-rich { border: 1px solid #999; box-shadow: none; }
    }
    .print-letterhead {
      text-align: center;
      padding: 12px 0 18px;
      border-bottom: 2px solid var(--maroon-700);
      margin-bottom: 18px;
    }
    .print-letterhead .school {
      font-family: var(--font-display);
      color: var(--maroon-900);
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .print-letterhead .tagline {
      font-size: 0.78rem;
      color: var(--ink-500);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-top: 2px;
    }
  </style>
</head>
<body>
  <div class="print-letterhead">
    <div class="school">Heartworks Learning Center</div>
    <div class="tagline">Generated Schedule and Assessment</div>
  </div>
  <div id="print-target"></div>
  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { window.print(); }, 250);
    });
  </script>
</body>
</html>`);
    w.document.close();
    const target = w.document.getElementById('print-target');
    if (target) target.appendChild(card);
  }

  // ----------- Subjects view -----------
  // The form serves both Add and Edit. When `#subj-edit-id` is non-empty,
  // the form is in edit mode: submit calls Subjects.update() instead of
  // Subjects.create().
  function enterSubjectEditMode(sub) {
    $('#subj-edit-id').value = sub.id;
    $('#subj-name').value = sub.name;
    $('#subj-grade').value = sub.gradeLevel;
    $('#subj-desc').value = sub.description || '';

    $('#subject-form-title').textContent = `Edit Subject — ${sub.name}`;
    $('#subject-form-hint').textContent = 'Existing student assignments referencing this subject keep their original snapshot — only the catalog entry is updated.';
    $('#subj-submit').textContent = 'Save Changes';
    $('#subj-cancel-edit').style.display = '';
    $('#subject-form-card').classList.add('editing');
    $('#subject-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exitSubjectEditMode() {
    $('#subj-edit-id').value = '';
    $('#subject-form').reset();
    $('#subject-form-title').textContent = 'Add a Subject';
    $('#subject-form-hint').textContent = 'Subjects defined here can be assigned to students as part of their curriculum';
    $('#subj-submit').textContent = 'Add Subject';
    $('#subj-cancel-edit').style.display = 'none';
    $('#subject-form-card').classList.remove('editing');
  }

  function initSubjectForm() {
    const grade = $('#subj-grade');
    CFG.GRADE_LEVELS.forEach(g => grade.appendChild(U.el('option', { value: g }, g)));

    $('#subj-cancel-edit').addEventListener('click', exitSubjectEditMode);

    $('#subject-form').addEventListener('submit', e => {
      e.preventDefault();
      const editingId = $('#subj-edit-id').value;
      const name  = $('#subj-name').value.trim();
      const gradeLevel = $('#subj-grade').value;
      const desc  = $('#subj-desc').value.trim();

      if (!U.isNonEmpty(name))               return U.toast('Subject name is required', 'error');
      if (!gradeLevel)                       return U.toast('Select a grade level', 'error');

      // Uniqueness check: when editing, ignore the subject's own id.
      const conflict = Subjects.getAll().find(s =>
        s.name.toLowerCase() === name.toLowerCase()
        && s.gradeLevel === gradeLevel
        && s.id !== editingId
      );
      if (conflict) return U.toast('That subject already exists for this grade', 'error');

      // -------- EDIT path --------
      if (editingId) {
        Subjects.update(editingId, { name, gradeLevel, description: desc });
        logActivity('registrar', 'subject.edit', `${name} · ${gradeLevel}`);
        U.toast(`Subject "${name}" updated`, 'success');
        exitSubjectEditMode();
        renderSubjectsList($('#subj-search').value);
        return;
      }

      // -------- ADD path --------
      const subject = {
        id: U.generateId('sub'),
        name,
        gradeLevel,
        // K–10 fixed tuition: subjects carry no per-subject fee.
        // The 0 keeps the existing assignSubjectsToStudent bridge working
        // (each assignment becomes a zero-amount curriculum entry).
        fee: 0,
        description: desc,
        createdAt: new Date().toISOString()
      };
      Subjects.create(subject);
      logActivity('registrar', 'subject.add', `${name} · ${gradeLevel}`);
      U.toast(`Added subject: ${name}`, 'success');
      e.target.reset();
      renderSubjectsList();
    });
  }

  function renderSubjectsList(filter) {
    const host = $('#subjects-list');
    U.clearNode(host);
    const all = Subjects.getAll();
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? all : all.filter(s =>
      s.name.toLowerCase().includes(f) || s.gradeLevel.toLowerCase().includes(f)
    );

    if (!list.length) {
      host.appendChild(emptyState('No subjects yet', f ? 'No matches.' : 'Use the form above to add your first subject.'));
      return;
    }

    list.sort((a, b) => a.gradeLevel.localeCompare(b.gradeLevel) || a.name.localeCompare(b.name)).forEach(sub => {
      const card = U.el('div', { class: 'subject-card' }, [
        U.el('div', { class: 'grade' }, sub.gradeLevel),
        U.el('h4', {}, sub.name),
        sub.description ? U.el('div', { class: 'desc' }, sub.description) : null,
        U.el('div', { class: 'actions' }, [
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => enterSubjectEditMode(sub)
          }, 'Edit'),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => deleteSubject(sub.id, sub.name)
          }, 'Remove')
        ])
      ].filter(Boolean));
      host.appendChild(card);
    });
  }

  function deleteSubject(id, name) {
    // Don't block on existing assignments — this just removes from catalog;
    // already-assigned charges remain on student records.
    if (!confirm(`Remove "${name}" from the catalog? Existing charges on students remain unchanged.`)) return;
    Subjects.remove(id);
    logActivity('registrar', 'subject.remove', name);
    U.toast('Subject removed', 'success');
    renderSubjectsList($('#subj-search').value);
  }

  // ----------- Assign Subjects modal -----------
  function openAssignModal(studentId) {
    const s = Students.getById(studentId);
    if (!s) return;

    $('#am-name').textContent = `Assign Subjects · ${fullName(s)}`;
    $('#am-info').textContent = `Grade level: ${s.gradeLevel}. Selected subjects will be added to this student's curriculum on their account.`;

    const host = $('#am-subjects');
    U.clearNode(host);

    const eligible = Subjects.getAll().filter(sub => sub.gradeLevel === s.gradeLevel);
    const alreadyIds = new Set((s.charges || []).filter(c => c.source === 'subject').map(c => c.subjectId));

    if (!eligible.length) {
      host.appendChild(emptyState(
        'No subjects defined for ' + s.gradeLevel,
        'Add subjects for this grade in the Subjects panel first.'
      ));
      $('#am-submit').disabled = true;
    } else {
      $('#am-submit').disabled = false;
      eligible.forEach(sub => {
        const isAssigned = alreadyIds.has(sub.id);
        const label = U.el('label', { class: isAssigned ? 'assigned' : '' }, [
          U.el('div', { style: 'display:flex;align-items:center;gap:10px;' }, [
            U.el('input', {
              type: 'checkbox',
              value: sub.id,
              ...(isAssigned ? { disabled: 'disabled', checked: 'checked' } : {})
            }),
            U.el('div', { class: 'info' }, [
              U.el('div', { class: 'nm' }, sub.name),
              U.el('div', { class: 'gr' }, isAssigned ? 'Already assigned' : sub.description || sub.gradeLevel)
            ])
          ])
        ]);
        host.appendChild(label);
      });
    }

    const submitBtn = $('#am-submit');
    submitBtn.onclick = () => {
      const checks = host.querySelectorAll('input[type="checkbox"]:not([disabled]):checked');
      const ids = Array.from(checks).map(c => c.value);
      if (!ids.length) {
        U.toast('Select at least one subject to assign', 'error');
        return;
      }
      const result = assignSubjectsToStudent(s.id, ids);
      logActivity('registrar', 'subjects.assign', `${result.assigned.length} subject(s) → ${fullName(s)}`);
      U.toast(`Assigned ${result.assigned.length} subject(s) to ${fullName(s)}`, 'success');
      closeAssignModal();
      renderStudentTable($('#students-search').value);
      // If the GSA view is currently visible, refresh it too so the newly
      // assigned subjects show up immediately under that student's card.
      if ($('#view-gsa').classList.contains('active')) {
        renderGSA($('#gsa-search').value);
      }
    };

    $('#assign-modal').classList.add('open');
  }
  function closeAssignModal() { $('#assign-modal').classList.remove('open'); }

  // ----------- Bulk import -----------
  //
  // Each import "kind" (students / subjects) has:
  //   - an alias map: canonical field → list of header strings that should
  //     map to that field. Header matching is case/space/punctuation
  //     insensitive, so "First Name", "FNAME", "first_name", "first.name"
  //     all resolve to firstName. See HLC_IMPORT.applyAliasMap.
  //   - a validator: takes the alias-resolved row, returns
  //     { valid, error?, normalized? } shaped for Storage.create().
  //
  // Headers in the alias map are matched flexibly; the canonical name
  // itself is always an alias (so the original "firstName" header works
  // unchanged).

  // Student alias map mirrors the Enrollment Form (enroll.html / onEnrollSubmit)
  // 1:1. Canonical names use dot-paths matching the JSON the form posts to
  // /api/online-enrollment/submit, so the validator can re-assemble that same
  // payload with no shape translation.
  //
  // Sections covered (form ⇄ canonical):
  //   1. Enrollment Info      → schoolYear, program, gradeLevel, enrollmentDate
  //   2. Learner              → learner.*
  //   3. Other                → other.shuttleService / carpoolService / escGrantee
  //   4. Father               → father.* (optional block — required if any field present)
  //   5. Mother               → mother.* (optional block — required if any field present)
  //   6. Emergency contact    → emergency.* (all required)
  //   (Required documents are file uploads only — no spreadsheet columns.)
  const IMPORT_ALIASES = {
    students: {
      // ── 1. Enrollment information ──
      schoolYear:        ['school year', 'sy', 'academic year', 'academicyear'],
      program:           ['program name', 'programname', 'level program', 'levelprogram'],
      gradeLevel:        ['grade level', 'grade', 'year level', 'yearlevel', 'level', 'year'],
      enrollmentDate:    ['enrollment date', 'date of enrollment', 'date enrolled', 'dateenrolled', 'enrolldate', 'enrolled on'],

      // ── 2. Learner's information ──
      'learner.lastName':           ['learner last name', 'learnerlastname', 'student last name', 'studentlastname', 'last name', 'lname', 'l_lastname', 'surname', 'family name', 'familyname'],
      'learner.firstName':          ['learner first name', 'learnerfirstname', 'student first name', 'studentfirstname', 'first name', 'fname', 'l_firstname', 'given name', 'givenname'],
      'learner.middleName':         ['learner middle name', 'learnermiddlename', 'student middle name', 'middle name', 'mname', 'l_middlename', 'middle initial', 'middleinitial', 'mi'],
      'learner.birthDate':          ['learner birth date', 'learnerbirthdate', 'student birth date', 'birth date', 'date of birth', 'dob', 'birthday', 'birthdate', 'date_of_birth', 'l_birthdate'],
      'learner.gender':             ['learner gender', 'learnergender', 'student gender', 'gender', 'sex', 'l_gender'],
      'learner.schoolLastAttended': ['school last attended', 'schoollastattended', 'last school', 'previous school', 'previousschool', 'l_school', 'former school', 'formerschool'],

      // ── 3. Other information ──
      'other.shuttleService':       ['shuttle service', 'shuttle', 'shuttleservice', 'uses shuttle', 'shuttle bus'],
      'other.carpoolService':       ['carpool service', 'carpool', 'carpoolservice', 'shuttle type', 'shuttletype'],
      'other.escGrantee':           ['esc grantee', 'escgrantee', 'esc', 'educational service contracting', 'esc grant'],

      // ── 4. Father's information ──
      'father.lastName':        ['father last name', 'fatherlastname', 'father surname', 'fathersurname', 'f_lastname', 'dad last name', 'dadlastname'],
      'father.firstName':       ['father first name', 'fatherfirstname', 'father given name', 'f_firstname', 'dad first name', 'dadfirstname'],
      'father.middleName':      ['father middle name', 'fathermiddlename', 'f_middlename', 'dad middle name'],
      'father.homeAddress':     ['father address', 'father home address', 'fatheraddress', 'fatherhomeaddress', 'f_address', 'dad address'],
      'father.religion':        ['father religion', 'fatherreligion', 'f_religion', 'dad religion'],
      'father.mobileNumber':    ['father mobile', 'fathermobile', 'father mobile number', 'fathermobilenumber', 'father phone', 'fatherphone', 'father cell', 'fathercell', 'f_mobile', 'dad mobile', 'dadmobile'],
      'father.telephoneNumber': ['father telephone', 'fathertelephone', 'father telephone number', 'fathertelephonenumber', 'father tel', 'fathertel', 'father landline', 'fatherlandline', 'f_tel'],

      // ── 5. Mother's information ──
      'mother.lastName':        ['mother last name', 'motherlastname', 'mother surname', 'mothersurname', 'm_lastname', 'mom last name', 'momlastname'],
      'mother.firstName':       ['mother first name', 'motherfirstname', 'mother given name', 'm_firstname', 'mom first name', 'momfirstname'],
      'mother.middleName':      ['mother middle name', 'mothermiddlename', 'mother maiden name', 'mothermaidenname', 'm_middlename', 'mom middle name'],
      'mother.homeAddress':     ['mother address', 'mother home address', 'motheraddress', 'motherhomeaddress', 'm_address', 'mom address'],
      'mother.religion':        ['mother religion', 'motherreligion', 'm_religion', 'mom religion'],
      'mother.mobileNumber':    ['mother mobile', 'mothermobile', 'mother mobile number', 'mothermobilenumber', 'mother phone', 'motherphone', 'mother cell', 'mothercell', 'm_mobile', 'mom mobile', 'mommobile'],
      'mother.telephoneNumber': ['mother telephone', 'mothertelephone', 'mother telephone number', 'mothertelephonenumber', 'mother tel', 'mothertel', 'mother landline', 'motherlandline', 'm_tel'],

      // ── 6. Emergency contact ──
      'emergency.fullName':     ['emergency contact', 'emergencycontact', 'emergency name', 'emergencyname', 'emergency full name', 'emergencyfullname', 'emergency contact name', 'emergencycontactname', 'e_fullname'],
      'emergency.relationship': ['emergency relationship', 'emergencyrelationship', 'emergency contact relationship', 'emergencycontactrelationship', 'relationship to learner', 'relationshiptolearner', 'relationship', 'e_relationship'],
      'emergency.mobileNumber': ['emergency mobile', 'emergencymobile', 'emergency mobile number', 'emergencymobilenumber', 'emergency contact mobile', 'emergencycontactmobile', 'emergency phone', 'emergencyphone', 'emergency cell', 'emergencycell', 'e_mobile'],
      'emergency.homeAddress':  ['emergency address', 'emergencyaddress', 'emergency home address', 'emergencyhomeaddress', 'emergency contact address', 'emergencycontactaddress', 'e_address']
    },
    subjects: {
      name:        ['subject', 'subject name', 'subjectname', 'title'],
      gradeLevel:  ['grade level', 'grade', 'year level', 'yearlevel', 'level'],
      description: ['desc', 'details', 'about']
    }
  };

  // Valid programs and gender values mirror enroll.html exactly.
  const IMPORT_PROGRAMS = ['Pre-School', 'Elementary', 'Junior High School'];
  const IMPORT_CARPOOL  = ['none', 'morning', 'afternoon'];

  // "yes" / "true" / "1" / "y" / "on" → true. Everything else → false.
  // Blank / undefined → false (the form's default for unchecked switches).
  function parseImportBool(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v == null) return false;
    const s = String(v).trim().toLowerCase();
    if (!s) return false;
    return /^(1|y|yes|true|t|on|✓|✔)$/.test(s);
  }

  function matchImportProgram(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    const n = s.toLowerCase().replace(/[\s-]+/g, '');
    for (const p of IMPORT_PROGRAMS) {
      if (p.toLowerCase().replace(/[\s-]+/g, '') === n) return p;
    }
    // Common shorthand: "preschool", "elem", "jhs", "highschool"
    if (/^(preschool|pre|prek|kinder)/.test(n))  return 'Pre-School';
    if (/^(elem|elementary|grade[1-6])/.test(n)) return 'Elementary';
    if (/^(jhs|junior|highschool|highschooljr|grade(7|8|9|10))/.test(n)) return 'Junior High School';
    return '';
  }

  // Normalize carpool to the form's enum values. Accepts the raw values
  // ("none" / "morning" / "afternoon") and friendly synonyms.
  function normalizeCarpool(v) {
    if (v == null) return '';
    const s = String(v).trim().toLowerCase();
    if (!s) return '';
    if (IMPORT_CARPOOL.includes(s)) return s;
    if (/round\s*trip|two\s*way|both/.test(s)) return 'none';
    if (/morning|am\b|^am$|am\s*only/.test(s)) return 'morning';
    if (/afternoon|pm\b|^pm$|pm\s*only/.test(s)) return 'afternoon';
    return '';
  }

  // Read a dot-pathed canonical field ("learner.firstName") off the
  // alias-resolved row, where applyAliasMap stores values with the dot keys
  // as plain strings (the alias map's canonical names are literal).
  function pick(row, key) {
    const v = row[key];
    return v === undefined || v === null ? '' : (typeof v === 'string' ? v.trim() : v);
  }

  const IMPORT_VALIDATORS = {
    students: (row) => {
      // Mirror enroll.html's onEnrollSubmit "required" list — same fields,
      // same messages format.
      const requiredMap = {
        enrollmentDate:          'Enrollment Date',
        schoolYear:              'School Year',
        program:                 'Program',
        gradeLevel:              'Grade Level',
        'learner.lastName':      'Learner Last Name',
        'learner.firstName':     'Learner First Name',
        'learner.birthDate':     'Date of Birth',
        'learner.gender':        'Gender',
        'emergency.fullName':    'Emergency Contact Name',
        'emergency.relationship':'Emergency Contact Relationship',
        'emergency.mobileNumber':'Emergency Contact Mobile',
        'emergency.homeAddress': 'Emergency Contact Address'
      };
      for (const k in requiredMap) {
        if (String(pick(row, k)).trim() === '') {
          return { valid: false, error: 'Missing ' + requiredMap[k] };
        }
      }

      // Program — must be one of the three form options.
      const program = matchImportProgram(pick(row, 'program'));
      if (!program) return { valid: false, error: 'Bad program: ' + row.program };

      // Grade level.
      const gradeLevel = window.HLC_IMPORT.matchGradeLevel(pick(row, 'gradeLevel'), CFG.GRADE_LEVELS);
      if (!gradeLevel) return { valid: false, error: 'Unknown grade: ' + row.gradeLevel };

      // Dates.
      const enrollmentDate = window.HLC_IMPORT.toIsoDate(pick(row, 'enrollmentDate'));
      if (!enrollmentDate) return { valid: false, error: 'Bad enrollmentDate: ' + row.enrollmentDate };
      const birthDate = window.HLC_IMPORT.toIsoDate(pick(row, 'learner.birthDate'));
      if (!birthDate) return { valid: false, error: 'Bad birthDate: ' + row['learner.birthDate'] };

      // Gender — form accepts Male / Female / Other; the existing helper only
      // normalizes M/F, so we accept "Other" verbatim too.
      let gender = window.HLC_IMPORT.normalizeGender(pick(row, 'learner.gender'));
      if (gender !== 'Male' && gender !== 'Female') {
        if (/^other$/i.test(String(pick(row, 'learner.gender')).trim())) gender = 'Other';
        else return { valid: false, error: 'Bad gender: ' + row['learner.gender'] };
      }

      // Other info.
      const shuttleService = parseImportBool(pick(row, 'other.shuttleService'));
      const escGrantee     = parseImportBool(pick(row, 'other.escGrantee'));
      let carpoolService = '';
      if (shuttleService) {
        carpoolService = normalizeCarpool(pick(row, 'other.carpoolService'));
        if (!carpoolService) {
          return { valid: false, error: 'Carpool Service is required when Shuttle Service is on' };
        }
      }

      // Parents — at least one fully filled in (lastName/firstName/address/mobile).
      // Same rule the form enforces. Treat any non-blank field in a block as
      // "started"; if started, the four key fields are required.
      const parentFields = ['lastName', 'firstName', 'middleName', 'homeAddress',
                            'religion', 'mobileNumber', 'telephoneNumber'];
      const parentBlock = (prefix) => {
        const out = {};
        let touched = false;
        parentFields.forEach(f => {
          const val = String(pick(row, prefix + '.' + f) || '').trim();
          out[f] = val;
          if (val) touched = true;
        });
        return { touched, data: out };
      };
      const father = parentBlock('father');
      const mother = parentBlock('mother');
      if (!father.touched && !mother.touched) {
        return { valid: false, error: "At least one parent's information is required (Father or Mother)" };
      }
      for (const [label, p] of [['Father', father], ['Mother', mother]]) {
        if (!p.touched) continue;
        for (const req of ['lastName', 'firstName', 'homeAddress', 'mobileNumber']) {
          if (!p.data[req]) {
            return { valid: false, error: `${label}'s ${req} is required (or clear the entire ${label} section)` };
          }
        }
      }

      // Build the payload shape addStudentOnline() / POST /submit expects.
      const payload = {
        schoolYear:     String(pick(row, 'schoolYear')).trim(),
        program,
        gradeLevel,
        enrollmentDate,
        learner: {
          lastName:           String(pick(row, 'learner.lastName')).trim(),
          firstName:          String(pick(row, 'learner.firstName')).trim(),
          middleName:         String(pick(row, 'learner.middleName') || '').trim(),
          birthDate,
          gender,
          schoolLastAttended: String(pick(row, 'learner.schoolLastAttended') || '').trim()
        },
        other: {
          shuttleService,
          carpoolService,
          escGrantee
        },
        emergency: {
          fullName:     String(pick(row, 'emergency.fullName')).trim(),
          mobileNumber: String(pick(row, 'emergency.mobileNumber')).trim(),
          relationship: String(pick(row, 'emergency.relationship')).trim(),
          homeAddress:  String(pick(row, 'emergency.homeAddress')).trim()
        }
      };
      if (father.touched) payload.father = father.data;
      if (mother.touched) payload.mother = mother.data;

      return { valid: true, normalized: payload };
    },
    subjects: (row) => {
      if (!row.name || !String(row.name).trim()) return { valid: false, error: 'Missing name' };
      if (!row.gradeLevel || !String(row.gradeLevel).trim()) return { valid: false, error: 'Missing gradeLevel' };
      const gradeLevel = window.HLC_IMPORT.matchGradeLevel(row.gradeLevel, CFG.GRADE_LEVELS);
      if (!gradeLevel) return { valid: false, error: 'Unknown grade: ' + row.gradeLevel };
      return {
        valid: true,
        normalized: {
          name: String(row.name).trim(),
          gradeLevel,
          // K–10 fixed tuition: subjects carry no per-subject fee.
          fee: 0,
          description: String(row.description || '').trim()
        }
      };
    }
  };

  // Headers used in the downloadable .xlsx template and sample-row preview.
  const IMPORT_TEMPLATES = {
    students: {
      headers: [
        // 1. Enrollment information
        'enrollmentDate', 'schoolYear', 'program', 'gradeLevel',
        // 2. Learner's information
        'learner.lastName', 'learner.firstName', 'learner.middleName',
        'learner.birthDate', 'learner.gender', 'learner.schoolLastAttended',
        // 3. Other information
        'other.shuttleService', 'other.carpoolService', 'other.escGrantee',
        // 4. Father's information
        'father.lastName', 'father.firstName', 'father.middleName',
        'father.homeAddress', 'father.religion',
        'father.mobileNumber', 'father.telephoneNumber',
        // 5. Mother's information
        'mother.lastName', 'mother.firstName', 'mother.middleName',
        'mother.homeAddress', 'mother.religion',
        'mother.mobileNumber', 'mother.telephoneNumber',
        // 6. Emergency contact
        'emergency.fullName', 'emergency.relationship',
        'emergency.mobileNumber', 'emergency.homeAddress'
      ],
      samples: [
        {
          'enrollmentDate': '2025-06-01', 'schoolYear': '2025-2026',
          'program': 'Elementary', 'gradeLevel': 'Grade 5',
          'learner.lastName': 'Cruz', 'learner.firstName': 'Maria', 'learner.middleName': 'Santos',
          'learner.birthDate': '2014-05-12', 'learner.gender': 'Female',
          'learner.schoolLastAttended': 'St. Mary Academy',
          'other.shuttleService': 'no', 'other.carpoolService': '', 'other.escGrantee': 'no',
          'father.lastName': 'Cruz', 'father.firstName': 'Pedro', 'father.middleName': 'Reyes',
          'father.homeAddress': '123 Mabini St, Quezon City', 'father.religion': 'Catholic',
          'father.mobileNumber': '09171234567', 'father.telephoneNumber': '',
          'mother.lastName': 'Cruz', 'mother.firstName': 'Ana', 'mother.middleName': 'Santos',
          'mother.homeAddress': '123 Mabini St, Quezon City', 'mother.religion': 'Catholic',
          'mother.mobileNumber': '09180000000', 'mother.telephoneNumber': '',
          'emergency.fullName': 'Lucia Santos', 'emergency.relationship': 'Aunt',
          'emergency.mobileNumber': '09190000000', 'emergency.homeAddress': '5 Rizal Ave, Quezon City'
        },
        {
          'enrollmentDate': '2025-06-01', 'schoolYear': '2025-2026',
          'program': 'Junior High School', 'gradeLevel': 'Grade 7',
          'learner.lastName': 'Reyes', 'learner.firstName': 'Juan', 'learner.middleName': '',
          'learner.birthDate': '2012-08-22', 'learner.gender': 'Male',
          'learner.schoolLastAttended': '',
          'other.shuttleService': 'yes', 'other.carpoolService': 'morning', 'other.escGrantee': 'yes',
          'father.lastName': '', 'father.firstName': '', 'father.middleName': '',
          'father.homeAddress': '', 'father.religion': '',
          'father.mobileNumber': '', 'father.telephoneNumber': '',
          'mother.lastName': 'Reyes', 'mother.firstName': 'Carla', 'mother.middleName': 'Dela Cruz',
          'mother.homeAddress': '45 Rizal Ave, Manila', 'mother.religion': '',
          'mother.mobileNumber': '09221112222', 'mother.telephoneNumber': '',
          'emergency.fullName': 'Roberto Reyes', 'emergency.relationship': 'Uncle',
          'emergency.mobileNumber': '09223334444', 'emergency.homeAddress': '45 Rizal Ave, Manila'
        }
      ]
    },
    subjects: {
      headers: ['name', 'gradeLevel', 'description'],
      samples: [
        { name: 'Mathematics 7', gradeLevel: 'Grade 7', description: 'Algebra and geometry' },
        { name: 'English 7',     gradeLevel: 'Grade 7', description: '' }
      ]
    }
  };

  // Cache for parsed-and-validated rows between Preview and Import. Each
  // entry: { results: [...], rawHeaders: [...], source: 'file:foo.xlsx' | 'paste' }
  const importCache = { students: null, subjects: null };

  // Track the last picked file per kind so the preview can show its name.
  const importFiles = { students: null, subjects: null };

  /**
   * Read whatever's available (file > pasted text) into raw rows, then
   * resolve aliases, run the validator, and stash the results. The same
   * code path is used by the file picker and by the Preview button.
   */
  async function loadImportRows(kind) {
    const ta = $('#ta-' + kind);
    const file = importFiles[kind];

    let parsed;
    let source;

    if (file) {
      parsed = await window.HLC_IMPORT.readSpreadsheetFile(file);
      source = 'file:' + file.name;
    } else {
      const text = ta ? ta.value : '';
      if (!text.trim()) throw new Error('No file selected and no rows pasted.');
      parsed = window.HLC_IMPORT.parsePastedText(text);
      source = 'paste';
    }

    if (!parsed.rows.length) {
      throw new Error('No data rows found — make sure you included a header row.');
    }

    const aliases = IMPORT_ALIASES[kind];
    const validator = IMPORT_VALIDATORS[kind];

    const results = parsed.rows.map(raw => {
      const aliased = window.HLC_IMPORT.applyAliasMap(raw, aliases);
      const v = validator(aliased);
      return { raw, aliased, ...v };
    });

    return { results, rawHeaders: parsed.headers, source };
  }

  async function previewImport(kind) {
    const previewHost = $('#preview-' + kind);
    const commitBtn = document.querySelector(`[data-import-commit="${kind}"]`);

    let bundle;
    try {
      bundle = await loadImportRows(kind);
    } catch (err) {
      previewHost.style.display = 'none';
      commitBtn.disabled = true;
      U.toast(err.message || 'Could not read import data', 'error');
      return;
    }

    const { results, rawHeaders, source } = bundle;
    const validCount = results.filter(r => r.valid).length;
    const invalidCount = results.length - validCount;
    importCache[kind] = bundle;

    const mapping = window.HLC_IMPORT.diagnoseHeaderMapping(rawHeaders, IMPORT_ALIASES[kind]);

    // Render preview
    U.clearNode(previewHost);
    previewHost.style.display = 'block';
    previewHost.appendChild(U.el('h5', {}, 'Preview'));

    // Header mapping ribbon — shows what got matched, what was ignored,
    // and what's missing entirely. This is the single biggest UX win:
    // when import fails users can see *why* in one glance.
    const mappingBox = U.el('div', { class: 'mapping' });
    mappingBox.appendChild(U.el('div', {}, [
      U.el('strong', {}, 'Source: '),
      document.createTextNode(source === 'paste' ? 'pasted text' : source.replace(/^file:/, '')),
      document.createTextNode(' · ' + results.length + ' row(s)')
    ]));

    if (mapping.mapped.length) {
      const row = U.el('div', { style: 'margin-top:6px;' });
      row.appendChild(U.el('strong', {}, 'Mapped: '));
      mapping.mapped.forEach(m => {
        row.appendChild(U.el('span', { class: 'mapped-chip' },
          m.raw === m.canonical ? m.canonical : (m.raw + ' → ' + m.canonical)));
      });
      mappingBox.appendChild(row);
    }
    if (mapping.unmapped.length) {
      const row = U.el('div', { style: 'margin-top:6px;' });
      row.appendChild(U.el('strong', {}, 'Ignored columns: '));
      mapping.unmapped.forEach(h => row.appendChild(U.el('span', { class: 'unmapped-chip' }, h)));
      mappingBox.appendChild(row);
    }
    if (mapping.missingCanonical.length) {
      // Optional canonical fields per kind — these missing won't fail the
      // import on their own (they're either truly optional in the form, or
      // conditional / part of an optional parent block).
      const optional = kind === 'students'
        ? new Set([
            'learner.middleName', 'learner.schoolLastAttended',
            'other.shuttleService', 'other.carpoolService', 'other.escGrantee',
            // Either father OR mother is required, not both — so all parent
            // fields are individually "optional" at the header level; the
            // row-level validator enforces the at-least-one rule and any
            // started-but-incomplete block.
            'father.lastName', 'father.firstName', 'father.middleName',
            'father.homeAddress', 'father.religion',
            'father.mobileNumber', 'father.telephoneNumber',
            'mother.lastName', 'mother.firstName', 'mother.middleName',
            'mother.homeAddress', 'mother.religion',
            'mother.mobileNumber', 'mother.telephoneNumber'
          ])
        : new Set(['description']);
      const missingRequired = mapping.missingCanonical.filter(c => !optional.has(c));
      if (missingRequired.length) {
        const row = U.el('div', { style: 'margin-top:6px;' });
        row.appendChild(U.el('strong', {}, 'Missing required: '));
        missingRequired.forEach(c => row.appendChild(U.el('span', { class: 'missing-chip' }, c)));
        mappingBox.appendChild(row);
      }
    }
    previewHost.appendChild(mappingBox);

    const summary = U.el('div', { class: 'summary' }, [
      U.el('span', { class: 'ok' }, `${validCount} valid`),
      invalidCount ? U.el('span', { class: 'err' }, `${invalidCount} invalid`) : null,
      U.el('span', {}, `${results.length} total rows`)
    ].filter(Boolean));
    previewHost.appendChild(summary);

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const cols = kind === 'students'
      ? ['First', 'Last', 'Program', 'Grade', 'Birth date', 'Parent', 'Status']
      : ['Name', 'Grade', 'Status'];
    cols.forEach(c => headRow.appendChild(U.el('th', {}, c)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    results.forEach(r => {
      const tr = document.createElement('tr');
      if (!r.valid) tr.className = 'invalid';
      if (kind === 'students') {
        // For valid rows, read off the normalized payload (form-shape).
        // For invalid rows, fall back to the raw aliased values so users
        // can see what they typed.
        const n = r.normalized || {};
        const a = r.aliased    || {};
        const learner = n.learner || {};
        const firstName = learner.firstName || a['learner.firstName'] || '—';
        const lastName  = learner.lastName  || a['learner.lastName']  || '—';
        const program   = n.program         || a.program              || '—';
        const grade     = n.gradeLevel      || (a.gradeLevel != null ? String(a.gradeLevel) : '—');
        const birth     = learner.birthDate || (a['learner.birthDate'] != null ? String(a['learner.birthDate']) : '—');
        // Show whichever parent is on the row, mirroring the form's
        // "primary parent" back-fill (father preferred, else mother).
        let parent = '—';
        const fName = (n.father && [n.father.firstName, n.father.lastName].filter(Boolean).join(' ')) || '';
        const mName = (n.mother && [n.mother.firstName, n.mother.lastName].filter(Boolean).join(' ')) || '';
        if (fName) parent = fName + ' (Father)';
        else if (mName) parent = mName + ' (Mother)';
        else {
          const fa = [a['father.firstName'], a['father.lastName']].filter(Boolean).join(' ');
          const ma = [a['mother.firstName'], a['mother.lastName']].filter(Boolean).join(' ');
          if (fa) parent = fa + ' (Father)';
          else if (ma) parent = ma + ' (Mother)';
        }
        tr.appendChild(U.el('td', {}, firstName));
        tr.appendChild(U.el('td', {}, lastName));
        tr.appendChild(U.el('td', {}, program));
        tr.appendChild(U.el('td', {}, grade));
        tr.appendChild(U.el('td', {}, birth));
        tr.appendChild(U.el('td', {}, parent));
        tr.appendChild(U.el('td', {}, r.valid ? '✓' : (r.error || 'invalid')));
      } else {
        const n = r.normalized || {};
        const a = r.aliased || {};
        tr.appendChild(U.el('td', {}, n.name       || a.name       || '—'));
        tr.appendChild(U.el('td', {}, n.gradeLevel || (a.gradeLevel != null ? String(a.gradeLevel) : '—')));
        tr.appendChild(U.el('td', {}, r.valid ? '✓' : (r.error || 'invalid')));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    previewHost.appendChild(table);

    commitBtn.disabled = validCount === 0;
  }

  async function commitImport(kind) {
    const cached = importCache[kind];
    if (!cached) return U.toast('Preview first', 'error');
    const valid = cached.results.filter(r => r.valid);
    if (!valid.length) return U.toast('No valid rows to import', 'error');

    const commitBtn = document.querySelector(`[data-import-commit="${kind}"]`);
    const originalLabel = commitBtn ? commitBtn.textContent : '';
    let createdCount = 0;
    let skipped = 0;
    const failures = [];   // { row, message } — collected so users can see why

    if (kind === 'students') {
      // Students go through the same /api/online-enrollment/submit + auto-
      // approve path the manual form uses, so they end up with proper
      // guardian rows, enrollment metadata, and the same auto-fee
      // application as a registrar-entered enrollment. Documents are NOT
      // imported (they're file uploads, not spreadsheet columns) — the
      // registrar can attach them later from the Records screen.
      if (commitBtn) { commitBtn.disabled = true; commitBtn.textContent = 'Importing…'; }
      for (let i = 0; i < valid.length; i++) {
        const r = valid[i];
        try {
          await addStudentOnline(r.normalized, []);
          createdCount++;
        } catch (err) {
          const learner = (r.normalized && r.normalized.learner) || {};
          const label = (learner.firstName || '') + ' ' + (learner.lastName || '');
          failures.push({
            row: label.trim() || ('Row ' + (i + 1)),
            message: (err && err.message) || 'submit failed'
          });
        }
      }
      if (commitBtn) commitBtn.textContent = originalLabel || 'Import';
      // Refresh the students cache so the new records appear in the table.
      if (window.HLC_STORAGE && window.HLC_STORAGE.bootstrap) {
        try { await window.HLC_STORAGE.bootstrap(); } catch (_) {}
      }
    } else if (kind === 'subjects') {
      const existing = Subjects.getAll();
      valid.forEach(r => {
        const dup = existing.find(s =>
          s.name.toLowerCase() === r.normalized.name.toLowerCase() &&
          s.gradeLevel === r.normalized.gradeLevel
        );
        if (dup) { skipped++; return; }
        Subjects.create({
          id: U.generateId('sub'),
          ...r.normalized,
          createdAt: new Date().toISOString()
        });
        createdCount++;
      });
    }

    const failedCount = failures.length;
    logActivity('registrar', `import.${kind}`,
      `${createdCount} created` +
      (skipped ? ', ' + skipped + ' duplicates skipped' : '') +
      (failedCount ? ', ' + failedCount + ' failed' : '')
    );

    let msg = `Imported ${createdCount} ${kind}`;
    if (skipped)     msg += ` (${skipped} duplicates skipped)`;
    if (failedCount) msg += ` — ${failedCount} failed`;
    U.toast(msg, failedCount && !createdCount ? 'error' : 'success');

    // Surface per-row failures in the preview so the user can fix and retry,
    // instead of silently dropping them.
    if (failedCount) {
      const previewHost = $('#preview-' + kind);
      if (previewHost) {
        const box = U.el('div', { class: 'mapping', style: 'margin-top:10px;border-color:var(--danger,#c0392b);' });
        box.appendChild(U.el('strong', {}, `${failedCount} row(s) failed to import:`));
        const ul = document.createElement('ul');
        ul.style.margin = '6px 0 0 18px';
        failures.forEach(f => {
          const li = document.createElement('li');
          li.textContent = `${f.row}: ${f.message}`;
          ul.appendChild(li);
        });
        box.appendChild(ul);
        previewHost.appendChild(box);
      }
    }

    // Clear inputs + preview only on success (so failures stay visible).
    if (!failedCount) {
      $('#ta-' + kind).value = '';
      importFiles[kind] = null;
      updateFileName(kind);
      $('#preview-' + kind).style.display = 'none';
      if (commitBtn) commitBtn.disabled = true;
      importCache[kind] = null;
    } else if (commitBtn) {
      // Keep the button enabled so they can re-try after fixing rows.
      commitBtn.disabled = false;
    }

    if (kind === 'students') renderDashboard();
    if (kind === 'subjects') renderSubjectsList();
  }

  function clearImport(kind) {
    $('#ta-' + kind).value = '';
    importFiles[kind] = null;
    updateFileName(kind);
    const fileInput = document.querySelector(`[data-import-file="${kind}"]`);
    if (fileInput) fileInput.value = '';
    $('#preview-' + kind).style.display = 'none';
    document.querySelector(`[data-import-commit="${kind}"]`).disabled = true;
    importCache[kind] = null;
  }

  function updateFileName(kind) {
    const el = document.querySelector(`[data-file-name="${kind}"]`);
    if (!el) return;
    const file = importFiles[kind];
    if (file) {
      el.textContent = file.name + ' (' + Math.max(1, Math.round(file.size / 1024)) + ' KB)';
      el.style.fontStyle = 'normal';
      el.style.color = 'var(--success)';
    } else {
      el.textContent = 'no file selected';
      el.style.fontStyle = 'italic';
      el.style.color = 'var(--ink-500)';
    }
  }

  async function handleFilePicked(kind, file) {
    importFiles[kind] = file || null;
    updateFileName(kind);
    if (!file) return;
    // Auto-preview as soon as a file is chosen — this is the "without
    // manual intervention" piece of the brief. The user picks the file,
    // sees the preview, clicks Import. Three clicks total.
    try {
      await previewImport(kind);
    } catch (_) {
      // previewImport already surfaced its own error toast.
    }
  }

  function initBulkImport() {
    // Reflect XLSX-lib availability into the UI so users on a blocked CDN
    // know why their Excel upload didn't work before they try it.
    const xlsxOk = window.HLC_IMPORT && window.HLC_IMPORT.hasXLSXLib();
    if (!xlsxOk) {
      document.querySelectorAll('[data-import-lib-warning]').forEach(el => {
        el.style.display = '';
      });
      document.querySelectorAll('[data-file-pick]').forEach(el => {
        // We don't disable the picker — CSVs still work — but we narrow
        // the accept= filter so the OS dialog hides the .xlsx option.
        const input = el.querySelector('input[type="file"]');
        if (input) input.setAttribute('accept', '.csv,.tsv,.txt');
        const label = el.querySelector('span');
        if (label) label.textContent = '📂 Choose CSV/TSV file';
      });
    }

    document.querySelectorAll('[data-import-preview]').forEach(btn => {
      btn.addEventListener('click', () => previewImport(btn.dataset.importPreview));
    });
    document.querySelectorAll('[data-import-commit]').forEach(btn => {
      btn.addEventListener('click', () => commitImport(btn.dataset.importCommit));
    });
    document.querySelectorAll('[data-import-clear]').forEach(btn => {
      btn.addEventListener('click', () => clearImport(btn.dataset.importClear));
    });
    document.querySelectorAll('[data-import-file]').forEach(input => {
      input.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        handleFilePicked(input.dataset.importFile, f);
      });
    });
    document.querySelectorAll('[data-import-template]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.importTemplate;
        const tpl = IMPORT_TEMPLATES[kind];
        if (!tpl) return;
        const filename = (kind === 'students' ? 'students-template' : 'subjects-template') + '.xlsx';
        window.HLC_IMPORT.downloadTemplate(filename, tpl.headers, tpl.samples);
      });
    });
  }

  // ----------- Boot -----------
  // ---------- Change Grade modal ----------
  // Two flows: 'correction' (typo fix, no fee changes) and 'promotion'
  // (move to new grade, optionally new SY, auto-apply fees for new context).
  // Backed by HLC_STORAGE.changeStudentGrade — see storage.js for semantics.
  let pendingGradeChangeStudentId = null;

  function openGradeChangeModal(studentId) {
    const s = Students.getById(studentId);
    if (!s) return;
    pendingGradeChangeStudentId = studentId;
    $('#gc-name').textContent = `Change Grade — ${fullName(s)}`;

    const sel = $('#gc-grade');
    U.clearNode(sel);
    CFG.GRADE_LEVELS.forEach(g => {
      const opt = U.el('option', { value: g }, g);
      if (g === s.gradeLevel) opt.selected = true;
      sel.appendChild(opt);
    });

    // Reset radios + SY field
    $$('input[name="gc-reason"]').forEach(r => { r.checked = (r.value === 'correction'); });
    $('#gc-sy-field').style.display = 'none';
    $('#gc-school-year').value = '';

    $('#grade-change-modal').classList.add('open');
  }

  function closeGradeChangeModal() {
    $('#grade-change-modal').classList.remove('open');
    pendingGradeChangeStudentId = null;
  }

  function initGradeChangeModal() {
    $$('[data-close-grade]').forEach(b => b.addEventListener('click', closeGradeChangeModal));
    $('#grade-change-modal').addEventListener('click', e => {
      if (e.target.id === 'grade-change-modal') closeGradeChangeModal();
    });
    // Toggle SY field visibility based on reason
    $$('input[name="gc-reason"]').forEach(r => {
      r.addEventListener('change', () => {
        const isPromotion = $('input[name="gc-reason"]:checked').value === 'promotion';
        $('#gc-sy-field').style.display = isPromotion ? '' : 'none';
      });
    });
    $('#gc-submit').addEventListener('click', () => {
      if (!pendingGradeChangeStudentId) return;
      const newGrade = $('#gc-grade').value;
      const reason = $('input[name="gc-reason"]:checked').value;
      const newSY = $('#gc-school-year').value.trim();
      if (!newGrade) return U.toast('Pick a grade', 'error');
      if (reason === 'promotion' && newSY && !/^\d{4}-\d{4}$/.test(newSY)) {
        return U.toast('School year format: YYYY-YYYY', 'error');
      }

      const before = Students.getById(pendingGradeChangeStudentId);
      const result = window.HLC_STORAGE.changeStudentGrade(pendingGradeChangeStudentId, newGrade, {
        reason,
        newSchoolYear: reason === 'promotion' && newSY ? newSY : null
      });
      if (!result) return U.toast('Could not change grade', 'error');

      const detailParts = [
        `${fullName(before)}`,
        `${before.gradeLevel} → ${newGrade}`,
        reason
      ];
      if (reason === 'promotion' && newSY) detailParts.push(`SY ${newSY}`);
      if (reason === 'promotion') {
        if (result.archivedCount)  detailParts.push(`${result.archivedCount} archived`);
        if (result.carryOverCount) detailParts.push(`${result.carryOverCount} carry-over (₱${(result.carryOverAmount || 0).toFixed(2)})`);
      }
      if (result.appliedFees.length) detailParts.push(`${result.appliedFees.length} fee(s) auto-applied`);
      logActivity('registrar', 'student.gradeChange', detailParts.join(' · '));

      let toastMsg;
      if (reason === 'promotion') {
        const bits = [`Promoted ${fullName(before)} to ${newGrade}`];
        if (result.archivedCount)   bits.push(`${result.archivedCount} item(s) archived`);
        if (result.carryOverCount)  bits.push(`${result.carryOverCount} carry-over`);
        if (result.appliedFees.length) bits.push(`${result.appliedFees.length} new fee(s) applied`);
        toastMsg = bits.join(' · ');
      } else {
        toastMsg = `Corrected grade to ${newGrade}`;
      }
      U.toast(toastMsg, 'success');
      closeGradeChangeModal();
      renderStudentTable($('#students-search').value);
      renderDashboard();
      // Refresh the GSA view if it's currently visible.
      if ($('#view-gsa').classList.contains('active')) {
        renderGSA($('#gsa-search').value);
      }
    });
  }

  // ============================================================
  // ----------- Edit & Delete Student (Directory) --------------
  // ============================================================
  // Both flows share a small helper: refresh every view that reads from
  // the Students cache so the directory, dashboard, and Student GSA all
  // reflect the change without a page reload. The cache is updated
  // optimistically by Students.update / Students.remove (see
  // storage.js#createCollection) so we can re-render synchronously here.
  function refreshAllStudentViews() {
    renderStudentTable($('#students-search').value);
    renderDashboard();
    if ($('#view-gsa').classList.contains('active')) {
      renderGSA($('#gsa-search').value);
    }
  }

  let pendingEditStudentId = null;
  // The hydrated submission record (parents + emergency + documents).
  // Loaded via GET /api/online-enrollment/submissions/:id when the modal
  // opens. Held here so save can diff against the original to detect which
  // guardian blocks the user actually changed.
  let editStudentExtras = null;

  // ── Required document types (mirror of the backend enum). The labels
  //    are friendly versions for the checklist UI; the keys must match
  //    what the backend's REQUIRED_DOCUMENT_TYPES expects. ──
  const REQUIRED_DOC_TYPES = [
    { key: 'affidavit_of_undertaking', label: 'Affidavit of Undertaking' },
    { key: 'report_card',              label: 'Report Card' },
    { key: 'good_moral',               label: 'Good Moral Certificate' },
    { key: 'psa_birth_certificate',    label: 'PSA Birth Certificate' },
    { key: 'doctors_advice',           label: "Doctor's Advice" },
    { key: 'sbt_result',               label: 'SBT Result' },
    { key: 'flu_vaccine_certificate',  label: 'Flu Vaccine Certificate' },
    { key: 'valid_id',                 label: 'Valid ID' }
  ];

  /**
   * Sync visibility of the carpool-service field with the shuttle-service
   * checkbox. Re-used from a couple of code paths so it lives as its own
   * helper.
   */
  function syncCarpoolVisibility() {
    const on = $('#es-shuttleService').checked;
    $('#es-carpool-wrap').style.display = on ? '' : 'none';
    if (!on) $('#es-carpoolService').value = '';
  }

  /**
   * Refresh the document checklist with a clean, pill-style design.
   *
   * Each row shows one of three states:
   *
   *   - GREEN "✓ UPLOADED"   → digital file on file. Shows filename and
   *                            a Replace button to swap the file.
   *   - BLUE  "✓ ON FILE (PHYSICAL)" → registrar logged a paper drop-off.
   *                            Shows who received it and when, with an
   *                            Unmark button. The row can ALSO be
   *                            digitized by uploading a scan — that
   *                            transitions it back to UPLOADED.
   *   - RED   "MISSING"      → nothing on file. Shows TWO actions:
   *                            a Choose File input (digital upload),
   *                            and a "Mark as Received" link for the
   *                            physical-drop-off flow.
   *
   * The status-gate counts both UPLOADED and PHYSICAL toward approval
   * readiness — the backend's missingRequiredDocuments() helper just
   * checks for row presence, regardless of receivedMethod.
   */
  function buildDocumentChecklist(documents) {
    const host = $('#es-doc-checklist');
    U.clearNode(host);
    const docs = documents || [];
    const byType = {};
    docs.forEach(d => { byType[d.documentType] = d; });
    const presentCount = REQUIRED_DOC_TYPES.filter(d => byType[d.key]).length;

    // Header counter.
    const counterEl = $('#es-doc-count');
    counterEl.textContent =
      `${presentCount} / ${REQUIRED_DOC_TYPES.length} on file`;
    counterEl.style.color = presentCount === REQUIRED_DOC_TYPES.length
      ? '#2e7d32' : 'var(--ink-500)';
    counterEl.style.fontWeight = presentCount === REQUIRED_DOC_TYPES.length
      ? '600' : '400';

    REQUIRED_DOC_TYPES.forEach(d => {
      const existing = byType[d.key];
      const isPhysical = existing && existing.receivedMethod === 'physical';
      const isUploaded = existing && existing.receivedMethod === 'uploaded';

      // Background / border tint depends on state.
      let bg, border;
      if (isUploaded)      { bg = '#f4faf5'; border = '#cde9d4'; }
      else if (isPhysical) { bg = '#f0f6fc'; border = '#cfdef0'; }
      else                 { bg = '#fef7f7'; border = '#f3d4d4'; }

      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;flex-wrap:wrap;gap:10px;' +
        'padding:8px 12px;background:' + bg + ';' +
        'border:1px solid ' + border + ';border-radius:4px;font-size:0.88rem;';

      // Document name on the left.
      const labelEl = document.createElement('span');
      labelEl.style.cssText = 'flex:1;min-width:160px;font-weight:500;color:var(--ink-900);';
      labelEl.textContent = d.label;
      row.appendChild(labelEl);

      if (isUploaded) {
        // ── UPLOADED state ──
        appendUploadedRow(row, d, existing);
      } else if (isPhysical) {
        // ── PHYSICAL state ──
        appendPhysicalRow(row, d, existing);
      } else {
        // ── MISSING state ──
        appendMissingRow(row, d);
      }

      host.appendChild(row);
    });

    refreshStatusGate();
  }

  /** Render the right-hand actions for an UPLOADED doc row. */
  function appendUploadedRow(row, d, doc) {
    const fnameEl = document.createElement('span');
    fnameEl.style.cssText =
      'font-size:0.78rem;color:var(--ink-500);max-width:200px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    fnameEl.title = doc.originalName || '';
    fnameEl.textContent = doc.originalName || '';
    row.appendChild(fnameEl);

    const pill = document.createElement('span');
    pill.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;' +
      'padding:2px 9px;border-radius:10px;font-size:0.72rem;' +
      'font-weight:600;background:#2e7d32;color:#fff;' +
      'letter-spacing:0.02em;';
    pill.textContent = '✓ UPLOADED';
    row.appendChild(pill);

    // Replace button → hidden file input, auto-upload on change.
    const replaceInput = document.createElement('input');
    replaceInput.type = 'file';
    replaceInput.style.display = 'none';
    replaceInput.addEventListener('change', () => {
      if (replaceInput.files && replaceInput.files[0]) {
        uploadOneDocument(replaceInput, d.key);
      }
    });

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.setAttribute('type', 'button');
    replaceBtn.className = 'btn btn-ghost btn-sm';
    replaceBtn.style.cssText = 'padding:3px 9px;font-size:0.72rem;';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      replaceInput.click();
    });
    row.appendChild(replaceInput);
    row.appendChild(replaceBtn);
  }

  /** Render the right-hand actions for a PHYSICAL doc row. */
  function appendPhysicalRow(row, d, doc) {
    // Show receipt metadata: "Received by X · MMM DD".
    const metaParts = [];
    if (doc.receivedBy) metaParts.push('Received by ' + doc.receivedBy);
    if (doc.receivedAt) metaParts.push(U.formatDate(doc.receivedAt));
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.style.cssText =
        'font-size:0.76rem;color:var(--ink-500);max-width:240px;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      meta.title = metaParts.join(' · ');
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);
    }

    const pill = document.createElement('span');
    pill.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;' +
      'padding:2px 9px;border-radius:10px;font-size:0.72rem;' +
      'font-weight:600;background:#1565c0;color:#fff;' +
      'letter-spacing:0.02em;';
    pill.textContent = '✓ ON FILE (PHYSICAL)';
    row.appendChild(pill);

    // "Scan & Upload" — turns a physical row into an uploaded one. The
    // backend's UPSERT in attachDocuments() flips received_method back
    // to 'uploaded' automatically.
    const scanInput = document.createElement('input');
    scanInput.type = 'file';
    scanInput.style.display = 'none';
    scanInput.addEventListener('change', () => {
      if (scanInput.files && scanInput.files[0]) {
        uploadOneDocument(scanInput, d.key);
      }
    });
    const scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.setAttribute('type', 'button');
    scanBtn.className = 'btn btn-ghost btn-sm';
    scanBtn.style.cssText = 'padding:3px 9px;font-size:0.72rem;';
    scanBtn.textContent = 'Attach Scan';
    scanBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      scanInput.click();
    });
    row.appendChild(scanInput);
    row.appendChild(scanBtn);

    // Unmark — pure physical rows are deleted entirely (back to Missing);
    // hybrid rows (file + physical metadata) just clear the metadata.
    const unmarkBtn = document.createElement('button');
    unmarkBtn.type = 'button';
    unmarkBtn.setAttribute('type', 'button');
    unmarkBtn.className = 'btn btn-ghost btn-sm';
    unmarkBtn.style.cssText =
      'padding:3px 9px;font-size:0.72rem;color:var(--danger,#c0392b);';
    unmarkBtn.textContent = 'Unmark';
    unmarkBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      unmarkPhysical(d.key);
    });
    row.appendChild(unmarkBtn);
  }

  /** Render the right-hand actions for a MISSING doc row. */
  function appendMissingRow(row, d) {
    const pill = document.createElement('span');
    pill.style.cssText =
      'display:inline-flex;align-items:center;' +
      'padding:2px 9px;border-radius:10px;font-size:0.72rem;' +
      'font-weight:600;background:#c0392b;color:#fff;' +
      'letter-spacing:0.02em;';
    pill.textContent = 'MISSING';
    row.appendChild(pill);

    // File input auto-uploads on change (digital path).
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.dataset.doctype = d.key;
    fileInput.style.cssText =
      'font-size:0.75rem;max-width:170px;cursor:pointer;';
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        uploadOneDocument(fileInput, d.key);
      }
    });
    row.appendChild(fileInput);

    // Or — physical drop-off path. A simple text-link button to keep
    // the row visually uncluttered next to the file input.
    const physBtn = document.createElement('button');
    physBtn.type = 'button';
    physBtn.setAttribute('type', 'button');
    physBtn.className = 'btn btn-ghost btn-sm';
    physBtn.style.cssText =
      'padding:3px 9px;font-size:0.72rem;background:#fff;';
    physBtn.textContent = 'Mark as Received (Physical)';
    physBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      markPhysical(d.key);
    });
    row.appendChild(physBtn);
  }

  /**
   * POST /api/online-enrollment/:id/documents/:type/mark-physical.
   * The backend stamps the logged-in registrar as receivedBy, falling
   * back to "registrar" if no email is on the token. We don't prompt
   * for a name here — keeping the flow one-click — but the audit trail
   * is preserved.
   */
  async function markPhysical(docType) {
    if (!pendingEditStudentId) return;
    const studentId = pendingEditStudentId;
    try {
      const data = await window.HLC_API.post(
        '/api/online-enrollment/' + studentId +
        '/documents/' + docType + '/mark-physical', {}
      );
      if (pendingEditStudentId !== studentId) return; // modal moved on

      // Patch the local extras snapshot. The backend returned the single
      // document row — splice it into our cached documents list.
      if (data && data.document && editStudentExtras) {
        const docs = (editStudentExtras.documents || []).slice();
        const idx = docs.findIndex(x => x.documentType === docType);
        if (idx === -1) docs.push(data.document);
        else docs[idx] = data.document;
        editStudentExtras.documents = docs;
      }

      // Defensive: re-assert open state in case anything in the await
      // chain tried to close the modal.
      $('#edit-student-modal').classList.add('open');
      U.toast('Logged physical receipt', 'success');
      buildDocumentChecklist(editStudentExtras && editStudentExtras.documents);
    } catch (err) {
      U.toast('Could not log receipt: ' +
              (err.message || 'unknown error'), 'error');
      $('#edit-student-modal').classList.add('open');
    }
  }

  /**
   * DELETE /api/online-enrollment/:id/documents/:type/mark-physical.
   * Removes the physical-receipt mark. If the row was physical-only,
   * the doc returns to MISSING. If it also had an uploaded file, the
   * file is preserved and the row stays in UPLOADED state.
   */
  async function unmarkPhysical(docType) {
    if (!pendingEditStudentId) return;
    if (!confirm('Remove the physical-receipt mark for this document?')) return;
    const studentId = pendingEditStudentId;
    try {
      const data = await window.HLC_API.del(
        '/api/online-enrollment/' + studentId +
        '/documents/' + docType + '/mark-physical'
      );
      if (pendingEditStudentId !== studentId) return;

      // The DELETE response is just { removed, fullyDeleted } — we don't
      // know the row's new state from that alone. Easiest: refresh the
      // full submission so the document list is authoritative.
      const full = await window.HLC_API.get(
        '/api/online-enrollment/submissions/' + studentId
      );
      if (pendingEditStudentId !== studentId) return;
      editStudentExtras = full;

      $('#edit-student-modal').classList.add('open');
      U.toast('Removed physical-receipt mark', 'success');
      buildDocumentChecklist(full.documents);
    } catch (err) {
      U.toast('Could not unmark: ' +
              (err.message || 'unknown error'), 'error');
      $('#edit-student-modal').classList.add('open');
    }
  }

  /**
   * Upload a single document for the student currently in the edit modal.
   * Multipart POST to /api/online-enrollment/:id/documents with the
   * file's fieldname set to the document type — the backend's multer
   * config (.any()) reads the fieldname to determine the type.
   *
   * On success, re-fetch the submission so the checklist refreshes with
   * the new file marked ✓.
   */
  async function uploadOneDocument(input, docType) {
    if (!pendingEditStudentId) return;
    const file = input.files && input.files[0];
    if (!file) return U.toast('Pick a file first', 'error');

    // Snapshot the student ID so a closed-and-reopened modal can't
    // leak the upload to the wrong record.
    const studentId = pendingEditStudentId;

    // Diagnostic logs — helps trace exactly what's happening if the
    // upload misbehaves.
    console.log('[upload] starting', { docType, fileName: file.name,
                                       size: file.size, studentId });

    const fd = new FormData();
    fd.append(docType, file);
    const url = window.HLC_API.BASE + '/api/online-enrollment/' +
                studentId + '/documents';
    console.log('[upload] POST', url);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + window.HLC_API.getToken() },
        body: fd
      });
      console.log('[upload] response status:', res.status);

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        console.error('[upload] failed:', e);
        throw new Error(e.error || ('HTTP ' + res.status));
      }
      const data = await res.json();
      console.log('[upload] success, documents:', data && data.documents);

      // Modal might have closed between fetch start and finish (rare —
      // e.g. user hit Cancel). Bail without re-rendering in that case.
      if (pendingEditStudentId !== studentId) {
        console.log('[upload] modal closed before response — skipping refresh');
        return;
      }

      // Update the local extras snapshot so the checklist reflects the
      // change without a full re-fetch.
      if (data && Array.isArray(data.documents) && editStudentExtras) {
        editStudentExtras.documents = data.documents;
      }

      // ── Defensive re-assertion ──
      // Make absolutely certain the modal stays open and we stay in
      // whatever view we were in. If some rogue handler tried to close
      // the modal during the await, this restores it.
      $('#edit-student-modal').classList.add('open');

      U.toast(`Uploaded ${file.name}`, 'success');
      buildDocumentChecklist(editStudentExtras && editStudentExtras.documents);
    } catch (err) {
      console.error('[upload] threw:', err);
      U.toast('Upload failed: ' + (err.message || 'unknown error'), 'error');
      // Even on failure, keep the modal open.
      $('#edit-student-modal').classList.add('open');
    }
  }

  /**
   * Show/hide the inline warning under the Status dropdown depending on
   * (a) the currently selected status and (b) whether all required
   * documents are present.
   *
   * The backend used to reject approve-with-missing-docs outright with an
   * HTTP 400. Now (per the two-phase approval flow) it records the
   * registrar's intent on the pending_approval flag instead and keeps
   * status='pending' until paperwork is complete. So we no longer disable
   * Save — we just surface a heads-up that the actual flip to 'Approved'
   * will wait on documents.
   */
  function refreshStatusGate() {
    const selected = $('#es-status').value;
    const wantsApproval = (selected === 'approved' || selected === 'enrolled');
    const docs = (editStudentExtras && editStudentExtras.documents) || [];
    const present = new Set(docs.map(d => d.documentType));
    const missing = REQUIRED_DOC_TYPES.filter(d => !present.has(d.key));
    const intentOnly = wantsApproval && missing.length > 0;

    const warnEl = $('#es-status-warning');
    if (intentOnly) {
      warnEl.style.display = '';
      warnEl.textContent =
        `Approval will be saved but ${missing.length} required document` +
        `${missing.length === 1 ? ' is' : 's are'} still missing — the ` +
        `student will stay Pending until paperwork is complete.`;
    } else {
      warnEl.style.display = 'none';
    }
    $('#es-submit').disabled = false;
    $('#es-submit').textContent = 'Save Changes';
  }

  function openEditStudentModal(studentId) {
    const s = Students.getById(studentId);
    if (!s) return;
    pendingEditStudentId = studentId;
    editStudentExtras = null;

    // ── Reset the modal ──
    $('#es-title').textContent = `Edit Student — ${fullName(s)}`;
    $('#es-id').value          = s.id;

    // Learner core
    $('#es-firstName').value          = s.firstName  || '';
    $('#es-middleName').value         = s.middleName || '';
    $('#es-lastName').value           = s.lastName   || '';
    $('#es-gender').value             = s.gender     || '';
    $('#es-birthDate').value          = s.birthDate  || '';
    $('#es-schoolLastAttended').value = s.schoolLastAttended || '';

    // Enrollment
    $('#es-status').value         = s.status     || 'pending';
    $('#es-gradeLevel').value     = s.gradeLevel || '';
    $('#es-program').value        = s.program    || '';
    $('#es-schoolYear').value     = s.schoolYear || '';
    $('#es-enrollmentDate').value = s.enrollmentDate || '';
    $('#es-shuttleService').checked = !!s.shuttleService;
    $('#es-carpoolService').value = s.carpoolService || '';
    $('#es-escGrantee').checked   = !!s.escGrantee;
    syncCarpoolVisibility();

    // Sections dropdown — rebuild every open so newly-created sections
    // appear immediately. The student's existing section is pre-selected.
    const secSel = $('#es-section');
    U.clearNode(secSel);
    secSel.appendChild(U.el('option', { value: '' }, '— Not assigned —'));
    window.HLC_STORAGE.Sections.getAll().forEach(sec => {
      const opt = U.el('option', { value: sec.id }, sec.name);
      if (sec.id === s.section) opt.selected = true;
      secSel.appendChild(opt);
    });

    // Guardian summary
    $('#es-guardianName').value = s.guardianName || '';
    $('#es-contact').value      = s.contact      || '';
    $('#es-address').value      = s.address      || '';
    $('#es-notes').value        = s.notes        || '';

    // Clear all family blocks first, then fill once the fetch comes back.
    $$('.es-guardian-block').forEach(blk => {
      blk.querySelectorAll('input[data-gfield]').forEach(inp => { inp.value = ''; });
      const status = blk.querySelector('.es-guardian-status');
      if (status) status.textContent = '(loading…)';
    });

    // Document checklist starts in a loading state.
    $('#es-doc-count').textContent = 'loading…';
    U.clearNode($('#es-doc-checklist'));
    $('#es-doc-checklist').appendChild(
      U.el('div', { style: 'color:var(--ink-500);font-size:0.82rem;' },
        'Loading document list…')
    );
    refreshStatusGate();

    $('#edit-student-modal').classList.add('open');

    // ── Async: hydrate parents + emergency + documents. ──
    window.HLC_API.get('/api/online-enrollment/submissions/' + studentId)
      .then(full => {
        // The user may have closed the modal or switched students before
        // the fetch resolved. Bail in that case.
        if (pendingEditStudentId !== studentId) return;
        editStudentExtras = full;

        // Populate guardian blocks. `full.father / mother / emergency`
        // come back from rowToGuardian — keys are camelCase.
        ['father', 'mother', 'emergency'].forEach(type => {
          const blk = document.querySelector(
            `.es-guardian-block[data-type="${type}"]`
          );
          if (!blk) return;
          const g = full[type] || {};
          blk.querySelectorAll('input[data-gfield]').forEach(inp => {
            const k = inp.dataset.gfield;
            inp.value = g[k] || '';
          });
          const status = blk.querySelector('.es-guardian-status');
          if (status) {
            const hasData = ['firstName','lastName','fullName','homeAddress','mobileNumber']
              .some(k => g[k]);
            status.textContent = hasData ? '(on file)' : '(empty)';
          }
        });

        buildDocumentChecklist(full.documents);
      })
      .catch(err => {
        if (pendingEditStudentId !== studentId) return;
        // Walk-in students or non-online enrollments may 404 — treat as
        // empty extras so the rest of the modal still works.
        editStudentExtras = { documents: [] };
        $$('.es-guardian-block').forEach(blk => {
          const status = blk.querySelector('.es-guardian-status');
          if (status) status.textContent = '(empty)';
        });
        buildDocumentChecklist([]);
        // Only toast if it wasn't a 404 — 404 is the expected "no record".
        if (err && err.status && err.status !== 404) {
          U.toast('Could not load family / document details', 'error');
        }
      });
  }

  function closeEditStudentModal() {
    $('#edit-student-modal').classList.remove('open');
    pendingEditStudentId = null;
    editStudentExtras = null;
    // Reset the save button in case it was disabled by the gate.
    $('#es-submit').disabled = false;
    $('#es-submit').textContent = 'Save Changes';
  }

  /**
   * Collect guardian field values for a given type from the DOM. Returns
   * an object with the same camelCase keys the backend expects.
   */
  function readGuardianBlock(type) {
    const blk = document.querySelector(
      `.es-guardian-block[data-type="${type}"]`
    );
    if (!blk) return {};
    const out = {};
    blk.querySelectorAll('input[data-gfield]').forEach(inp => {
      out[inp.dataset.gfield] = inp.value.trim();
    });
    return out;
  }

  /**
   * Returns true if two guardian objects differ on at least one field
   * we care about. Used to decide whether to fire a guardian save.
   */
  function guardiansDiffer(before, after) {
    const keys = ['firstName','middleName','lastName','fullName',
                  'relationship','homeAddress','religion',
                  'mobileNumber','telephoneNumber'];
    for (const k of keys) {
      const a = ((before && before[k]) || '').trim();
      const b = ((after  && after[k])  || '').trim();
      if (a !== b) return true;
    }
    return false;
  }

  async function submitEditStudent() {
    if (!pendingEditStudentId) return;
    const before = Students.getById(pendingEditStudentId);
    if (!before) {
      U.toast('Student no longer exists', 'error');
      closeEditStudentModal();
      refreshAllStudentViews();
      return;
    }

    // Approve-with-missing-docs is no longer a client-side block. The
    // backend now records the registrar's approval intent on the
    // pending_approval flag and keeps status='pending' until the last
    // required document is filed (at which point the backend auto-flips
    // status to 'approved'). We still compute `intentOnly` here so we can
    // tailor the success toast.
    const wantsApprove = ($('#es-status').value === 'approved' ||
                          $('#es-status').value === 'enrolled');
    let intentOnly = false;
    if (wantsApprove) {
      const docs = (editStudentExtras && editStudentExtras.documents) || [];
      const present = new Set(docs.map(d => d.documentType));
      const missing = REQUIRED_DOC_TYPES.filter(d => !present.has(d.key));
      const wasAlreadyApproved = (before.status === 'approved' ||
                                  before.status === 'enrolled');
      if (missing.length && !wasAlreadyApproved) intentOnly = true;
    }

    // ── Build the student-level patch ──
    const patch = {
      firstName:          $('#es-firstName').value.trim(),
      middleName:         $('#es-middleName').value.trim(),
      lastName:           $('#es-lastName').value.trim(),
      gender:             $('#es-gender').value,
      birthDate:          $('#es-birthDate').value || '',
      schoolLastAttended: $('#es-schoolLastAttended').value.trim(),
      status:             $('#es-status').value,
      program:            $('#es-program').value,
      schoolYear:         $('#es-schoolYear').value.trim(),
      enrollmentDate:     $('#es-enrollmentDate').value || '',
      shuttleService:     $('#es-shuttleService').checked,
      // Backend stores carpool as NULL when shuttle is off.
      carpoolService:     $('#es-shuttleService').checked
                            ? $('#es-carpoolService').value : '',
      escGrantee:         $('#es-escGrantee').checked,
      section:            $('#es-section').value,
      guardianName:       $('#es-guardianName').value.trim(),
      contact:            $('#es-contact').value.trim(),
      address:            $('#es-address').value.trim(),
      notes:              $('#es-notes').value.trim()
    };

    if (!patch.firstName) return U.toast('First name is required', 'error');
    if (!patch.lastName)  return U.toast('Last name is required',  'error');
    if (patch.schoolYear && !/^\d{4}-\d{4}$/.test(patch.schoolYear)) {
      return U.toast('School Year format: YYYY-YYYY', 'error');
    }

    // ── Fire the student-level update (optimistic, see storage.js) ──
    const updated = Students.update(pendingEditStudentId, patch);
    if (!updated) {
      U.toast('Could not save changes', 'error');
      return;
    }

    // ── Fire guardian updates in parallel. We only send blocks the
    //    user actually touched (otherwise an unchanged "empty" block
    //    would needlessly trigger the delete branch on the backend). ──
    const guardianTasks = [];
    const guardianTypesSaved = [];
    ['father', 'mother', 'emergency'].forEach(type => {
      const after  = readGuardianBlock(type);
      const beforeG = (editStudentExtras && editStudentExtras[type]) || null;
      if (!guardiansDiffer(beforeG, after)) return;
      guardianTypesSaved.push(type);
      guardianTasks.push(
        window.HLC_API.patch(
          '/api/online-enrollment/submissions/' +
            pendingEditStudentId + '/guardians/' + type,
          after
        ).catch(err => ({
          // Don't reject the whole save just because one guardian failed.
          _failed: true,
          type,
          message: err && err.message
        }))
      );
    });

    const guardianResults = await Promise.all(guardianTasks);
    const guardianFailures = guardianResults.filter(r => r && r._failed);
    const guardianSuccessCount = guardianResults.length - guardianFailures.length;

    // ── Activity-log entry ──
    const changedFields = Object.keys(patch).filter(k => {
      const a = before[k] == null ? '' : String(before[k]);
      const b = patch[k]  == null ? '' : String(patch[k]);
      return a !== b;
    });
    const detailBits = [];
    if (changedFields.length) detailBits.push(`updated: ${changedFields.join(', ')}`);
    if (guardianSuccessCount) {
      const okTypes = guardianTypesSaved.filter((_, i) => !(guardianResults[i] && guardianResults[i]._failed));
      detailBits.push(`guardians: ${okTypes.join(', ')}`);
    }
    if (guardianFailures.length) {
      detailBits.push(`${guardianFailures.length} guardian save(s) failed`);
    }
    const detail = detailBits.length
      ? `${fullName(before)} — ${detailBits.join(' · ')}`
      : `${fullName(before)} — no field changes`;
    logActivity('registrar', 'student.edit', detail);

    // ── User feedback ──
    if (guardianFailures.length) {
      U.toast(
        `Saved student fields but ${guardianFailures.length} guardian save(s) failed — try again`,
        'error'
      );
    } else if (intentOnly) {
      U.toast(
        `Saved — approval waiting on required documents (status stays Pending until paperwork is complete)`,
        'info'
      );
      closeEditStudentModal();
    } else {
      U.toast(`Saved changes to ${fullName(updated)}`, 'success');
      closeEditStudentModal();
    }
    refreshAllStudentViews();
  }

  function initEditStudentModal() {
    $$('[data-close-edit]').forEach(b => b.addEventListener('click', closeEditStudentModal));
    $('#edit-student-modal').addEventListener('click', e => {
      if (e.target.id === 'edit-student-modal') closeEditStudentModal();
    });
    $('#es-submit').addEventListener('click', submitEditStudent);
    $('#es-form').addEventListener('submit', e => {
      e.preventDefault();
      submitEditStudent();
    });
    // Live shuttle/carpool toggle.
    $('#es-shuttleService').addEventListener('change', syncCarpoolVisibility);
    // Live status gate.
    $('#es-status').addEventListener('change', refreshStatusGate);
  }

  // ----------- Delete Student -----------
  // Hard delete with a name-typing confirmation. FK ON DELETE CASCADE in
  // the schema removes the student's charges, payments, payment_charges,
  // subject assignments, family/document rows, etc. — so the GSA entry
  // (which is a derived view of those rows) disappears too.
  let pendingDeleteStudentId = null;

  function openDeleteStudentModal(studentId) {
    const s = Students.getById(studentId);
    if (!s) return;
    pendingDeleteStudentId = studentId;
    $('#ds-title').textContent = 'Delete Student';
    $('#ds-name').textContent  = fullName(s);
    $('#ds-confirm').value = '';
    $('#ds-submit').disabled = true;
    $('#delete-student-modal').classList.add('open');
    // Focus the confirm field so the user can start typing immediately.
    setTimeout(() => $('#ds-confirm').focus(), 50);
  }

  function closeDeleteStudentModal() {
    $('#delete-student-modal').classList.remove('open');
    pendingDeleteStudentId = null;
  }

  function submitDeleteStudent() {
    if (!pendingDeleteStudentId) return;
    const s = Students.getById(pendingDeleteStudentId);
    if (!s) {
      U.toast('Student no longer exists', 'error');
      closeDeleteStudentModal();
      refreshAllStudentViews();
      return;
    }

    // Defense-in-depth — the button is disabled until the typed name
    // matches, but verify again here in case the user pasted via the
    // keyboard handler race.
    const typed = ($('#ds-confirm').value || '').trim().toLowerCase();
    if (typed !== (s.lastName || '').trim().toLowerCase()) {
      U.toast('Last name does not match — deletion cancelled', 'error');
      return;
    }

    const name = fullName(s);
    // Optimistic remove — Students.remove drops the row from the cache
    // immediately and fires DELETE /api/students/:id in the background.
    // If the server rejects, storage.js re-inserts the row and toasts.
    const ok = Students.remove(pendingDeleteStudentId);
    if (!ok) {
      U.toast('Could not delete student', 'error');
      return;
    }

    logActivity('registrar', 'student.delete',
      `${name} (${s.gradeLevel}) — deleted along with charges, payments, and GSA`);
    U.toast(`Deleted ${name}`, 'success');
    closeDeleteStudentModal();
    refreshAllStudentViews();
  }

  function initDeleteStudentModal() {
    $$('[data-close-delete]').forEach(b => b.addEventListener('click', closeDeleteStudentModal));
    $('#delete-student-modal').addEventListener('click', e => {
      if (e.target.id === 'delete-student-modal') closeDeleteStudentModal();
    });
    // Enable the delete button only when the typed text matches the
    // student's last name (case-insensitive). Done live on every keystroke.
    $('#ds-confirm').addEventListener('input', () => {
      if (!pendingDeleteStudentId) return;
      const s = Students.getById(pendingDeleteStudentId);
      if (!s) return;
      const typed   = ($('#ds-confirm').value || '').trim().toLowerCase();
      const target  = (s.lastName || '').trim().toLowerCase();
      $('#ds-submit').disabled = !(typed && typed === target);
    });
    $('#ds-confirm').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !$('#ds-submit').disabled) {
        e.preventDefault();
        submitDeleteStudent();
      }
    });
    $('#ds-submit').addEventListener('click', submitDeleteStudent);
  }

  function init() {
    $('#page-meta').textContent = U.formatDateTime(new Date().toISOString());

    $$('.nav-list button').forEach(btn => {
      btn.addEventListener('click', () => setActiveView(btn.dataset.view));
    });

    $$('[data-close-modal]').forEach(b => b.addEventListener('click', closeModal));
    $('#student-modal').addEventListener('click', e => { if (e.target.id === 'student-modal') closeModal(); });

    $$('[data-close-assign]').forEach(b => b.addEventListener('click', closeAssignModal));
    $('#assign-modal').addEventListener('click', e => { if (e.target.id === 'assign-modal') closeAssignModal(); });

    $('#students-search').addEventListener('input', e => renderStudentTable(e.target.value));
    $('#subj-search').addEventListener('input', e => renderSubjectsList(e.target.value));

    // Student GSA listeners
    $('#gsa-search').addEventListener('input', e => renderGSA(e.target.value));
    $('#gsa-expand-all').addEventListener('click', () => {
      $$('#gsa-grid details.gsa-collapsible').forEach(d => { d.open = true; });
    });
    $('#gsa-collapse-all').addEventListener('click', () => {
      $$('#gsa-grid details.gsa-collapsible').forEach(d => { d.open = false; });
    });

    initEnrollForm();
    initSubjectForm();
    initSchoolYearForm();
    initBulkImport();
    initGradeChangeModal();
    initEditStudentModal();
    initDeleteStudentModal();
    renderDashboard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
