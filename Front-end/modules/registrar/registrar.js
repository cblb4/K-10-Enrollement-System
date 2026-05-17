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
      // Refresh the cache so the new student shows in Records immediately.
      if (window.HLC_STORAGE && window.HLC_STORAGE.bootstrap) {
        await window.HLC_STORAGE.bootstrap();
      }
      setActiveView('students');
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
      (s.gradeLevel || '').toLowerCase().includes(f) ||
      (s.program || '').toLowerCase().includes(f) ||
      (s.status || '').toLowerCase().includes(f) ||
      (s.guardianName || '').toLowerCase().includes(f)
    );

    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.appendChild(emptyState('No students found', f ? 'Try a different search term.' : 'Add your first student through New Enrollment.'));
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).forEach(s => {
      const tr = document.createElement('tr');
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
      if (s.status === 'pending') {
        actions.appendChild(U.el('button', {
          class: 'btn btn-primary btn-sm',
          style: 'margin-left:6px;',
          onclick: () => { updateStatus(s.id, 'approved'); U.toast('Marked as approved', 'success'); renderStudentTable($('#students-search').value); renderDashboard(); }
        }, 'Approve'));
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
          const a = U.el('a', {
            href: window.HLC_API.BASE + d.url, target: '_blank',
            rel: 'noopener', class: 'doc-link'
          }, (DOC_LABELS[d.documentType] || d.documentType) +
             ' — ' + d.originalName);
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

  const IMPORT_ALIASES = {
    students: {
      firstName:    ['first name', 'fname', 'given name', 'givenname'],
      lastName:     ['last name', 'lname', 'surname', 'family name', 'familyname'],
      middleName:   ['middle name', 'mname', 'middle initial', 'middleinitial', 'mi'],
      birthDate:    ['birth date', 'date of birth', 'dob', 'birthday', 'birthdate', 'date_of_birth'],
      gender:       ['sex'],
      gradeLevel:   ['grade level', 'grade', 'year level', 'yearlevel', 'level', 'year'],
      guardianName: ['guardian name', 'guardian', 'parent', 'parent name', 'parentname', 'parent/guardian', 'parentguardian'],
      contact:      ['contact number', 'phone', 'phone number', 'phonenumber', 'mobile', 'mobile number', 'cellphone', 'cell', 'tel', 'telephone'],
      address:      ['home address', 'homeaddress', 'residence', 'street address', 'streetaddress'],
      notes:        ['remarks', 'comments', 'note']
    },
    subjects: {
      name:        ['subject', 'subject name', 'subjectname', 'title'],
      gradeLevel:  ['grade level', 'grade', 'year level', 'yearlevel', 'level'],
      description: ['desc', 'details', 'about']
    }
  };

  const IMPORT_VALIDATORS = {
    students: (row) => {
      const required = ['firstName', 'lastName', 'birthDate', 'gender', 'gradeLevel', 'guardianName', 'contact', 'address'];
      for (const k of required) {
        if (row[k] === undefined || row[k] === null || String(row[k]).trim() === '') {
          return { valid: false, error: 'Missing ' + k };
        }
      }

      const gradeLevel = window.HLC_IMPORT.matchGradeLevel(row.gradeLevel, CFG.GRADE_LEVELS);
      if (!gradeLevel) {
        return { valid: false, error: 'Unknown grade: ' + row.gradeLevel };
      }

      const birthDate = window.HLC_IMPORT.toIsoDate(row.birthDate);
      if (!birthDate) {
        return { valid: false, error: 'Bad birthDate: ' + row.birthDate };
      }

      const gender = window.HLC_IMPORT.normalizeGender(row.gender);
      if (gender !== 'Male' && gender !== 'Female') {
        return { valid: false, error: 'Bad gender: ' + row.gender };
      }

      return {
        valid: true,
        normalized: {
          firstName:    String(row.firstName).trim(),
          lastName:     String(row.lastName).trim(),
          middleName:   String(row.middleName || '').trim(),
          birthDate,
          gender,
          gradeLevel,
          guardianName: String(row.guardianName).trim(),
          contact:      String(row.contact).trim(),
          address:      String(row.address).trim(),
          notes:        String(row.notes || '').trim()
        }
      };
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
      headers: ['firstName', 'middleName', 'lastName', 'birthDate', 'gender', 'gradeLevel', 'guardianName', 'contact', 'address', 'notes'],
      samples: [
        { firstName: 'Maria', middleName: 'Santos', lastName: 'Cruz', birthDate: '2014-05-12', gender: 'Female', gradeLevel: 'Grade 5', guardianName: 'Ana Cruz', contact: '09171234567', address: '123 Mabini St', notes: '' },
        { firstName: 'Juan',  middleName: '',       lastName: 'Reyes', birthDate: '2013-08-22', gender: 'Male',   gradeLevel: 'Grade 6', guardianName: 'Pedro Reyes', contact: '09180000000', address: '45 Rizal Ave',  notes: '' }
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
      const optional = kind === 'students'
        ? new Set(['middleName', 'notes'])
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
      ? ['First', 'Last', 'Grade', 'Birth date', 'Guardian', 'Status']
      : ['Name', 'Grade', 'Status'];
    cols.forEach(c => headRow.appendChild(U.el('th', {}, c)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    results.forEach(r => {
      const tr = document.createElement('tr');
      if (!r.valid) tr.className = 'invalid';
      if (kind === 'students') {
        const n = r.normalized || {};
        const a = r.aliased || {};
        tr.appendChild(U.el('td', {}, n.firstName    || a.firstName    || '—'));
        tr.appendChild(U.el('td', {}, n.lastName     || a.lastName     || '—'));
        tr.appendChild(U.el('td', {}, n.gradeLevel   || (a.gradeLevel != null ? String(a.gradeLevel) : '—')));
        tr.appendChild(U.el('td', {}, n.birthDate    || (a.birthDate  != null ? String(a.birthDate)  : '—')));
        tr.appendChild(U.el('td', {}, n.guardianName || a.guardianName || '—'));
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

  function commitImport(kind) {
    const cached = importCache[kind];
    if (!cached) return U.toast('Preview first', 'error');
    const valid = cached.results.filter(r => r.valid);
    if (!valid.length) return U.toast('No valid rows to import', 'error');

    let createdCount = 0;
    let skipped = 0;

    if (kind === 'students') {
      valid.forEach(r => {
        addStudent(r.normalized);
        createdCount++;
      });
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

    logActivity('registrar', `import.${kind}`, `${createdCount} created${skipped ? ', ' + skipped + ' duplicates skipped' : ''}`);
    const msg = skipped
      ? `Imported ${createdCount} ${kind} (${skipped} duplicates skipped)`
      : `Imported ${createdCount} ${kind}`;
    U.toast(msg, 'success');

    // Clear inputs + preview
    $('#ta-' + kind).value = '';
    importFiles[kind] = null;
    updateFileName(kind);
    $('#preview-' + kind).style.display = 'none';
    document.querySelector(`[data-import-commit="${kind}"]`).disabled = true;
    importCache[kind] = null;

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
    renderDashboard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
