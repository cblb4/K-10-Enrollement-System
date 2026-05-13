/**
 * admin.js
 * Business Admin: sections, student assignment, faculty management, audit log.
 *
 * Faculty photos are stored as data URLs in localStorage. With a real backend
 * you'd swap _readPhotoFile() for an upload-to-storage call and store only
 * the resulting URL.
 */
(function () {
  'use strict';

  // Auth guard
  const me = window.HLC_AUTH.requireRole('admin', '../../auth.html');
  if (!me) return;

  const { Students, Sections, ActivityLog, Faculty, logActivity } = window.HLC_STORAGE;
  const U = window.HLC_UTILS;
  const CFG = window.HLC_CONFIG;
  const $ = U.$, $$ = U.$$;

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

  function fullName(s) { return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '); }
  function facultyFull(f) { return `${f.firstName || ''} ${f.lastName || ''}`.trim(); }
  function initials(f) {
    return ((f.firstName || ' ')[0] + (f.lastName || ' ')[0]).toUpperCase();
  }

  // Photo upload state (kept in module scope so the form can submit it)
  let pendingPhotoDataUrl = null;

  // ----------- View routing -----------
  function setActiveView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-list button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    const titles = {
      dashboard: ['Operations', 'Overview'],
      sections:  ['Structure',  'Sections'],
      assign:    ['Placement',  'Assign Students'],
      faculty:   ['People',     'Faculty Management'],
      import:    ['Bulk Operations', 'Bulk Import'],
      activity:  ['Audit',      'Activity Log']
    };
    const [eyebrow, title] = titles[name] || titles.dashboard;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    if (name === 'dashboard') renderDashboard();
    if (name === 'sections')  renderSections();
    if (name === 'assign')    { populateAssignDropdowns(); renderAssignedTable(); }
    if (name === 'faculty')   renderFaculty();
    if (name === 'activity')  renderActivity();
  }

  // ----------- Dashboard (unchanged) -----------
  function renderDashboard() {
    const allStudents = Students.getAll();
    const allSections = Sections.getAll();

    const enrolled = allStudents.filter(s => s.status === 'enrolled' || s.status === 'approved').length;
    const pending  = allStudents.filter(s => s.status === 'pending').length;

    const stats = $('#admin-stats');
    U.clearNode(stats);
    [
      { label: 'Total Students',  value: String(allStudents.length) },
      { label: 'Enrolled',        value: String(enrolled), gold: true },
      { label: 'Pending',         value: String(pending) },
      { label: 'Active Sections', value: String(allSections.length) }
    ].forEach(t => {
      stats.appendChild(U.el('div', { class: 'stat' + (t.gold ? ' gold' : '') }, [
        U.el('div', { class: 'label' }, t.label),
        U.el('div', { class: 'value' }, t.value)
      ]));
    });

    const dist = $('#grade-distribution');
    U.clearNode(dist);
    const byGrade = U.groupBy(allStudents, s => s.gradeLevel || 'Unassigned');
    const max = Math.max(1, ...Object.values(byGrade).map(arr => arr.length));
    CFG.GRADE_LEVELS.forEach(g => {
      const count = (byGrade[g] || []).length;
      const pct = (count / max) * 100;
      dist.appendChild(U.el('div', { class: 'bar-row' }, [
        U.el('div', { class: 'lbl' }, g),
        U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: `width:${pct}%;` })]),
        U.el('div', { class: 'num' }, String(count))
      ]));
    });
    if (allStudents.length === 0) {
      dist.appendChild(U.el('div', { style: 'text-align:center;color:var(--ink-500);padding:18px 0;font-size:0.88rem;' }, 'No students enrolled yet.'));
    }

    const summary = $('#section-summary');
    U.clearNode(summary);
    if (!allSections.length) {
      summary.appendChild(U.el('div', { style: 'text-align:center;color:var(--ink-500);padding:24px 0;font-size:0.9rem;' }, 'No sections created yet.'));
      return;
    }
    allSections.forEach(sec => {
      const assigned = allStudents.filter(s => s.section === sec.id).length;
      summary.appendChild(U.el('div', { class: 'summary-row' }, [
        U.el('div', { class: 'left' }, [
          U.el('div', { class: 'name' }, sec.name),
          U.el('div', { class: 'grade' }, `${sec.gradeLevel} · Adviser: ${sec.adviser}`)
        ]),
        U.el('div', { class: 'right' }, [
          U.el('span', {}, `${assigned} / ${sec.capacity}`),
          U.el('span', { class: 'pill ' + (assigned >= sec.capacity ? 'pill-rejected' : 'pill-approved') }, assigned >= sec.capacity ? 'Full' : 'Open')
        ])
      ]));
    });
  }

  // ----------- Sections -----------
  // The form serves both Add and Edit. When `#sec-edit-id` is non-empty, the
  // form is in edit mode: submit calls Sections.update() instead of
  // Sections.create(), the title and submit button are relabeled, and a
  // "Cancel edit" button appears. enterSectionEditMode/exitSectionEditMode
  // toggle the chrome.
  function enterSectionEditMode(sec) {
    $('#sec-edit-id').value = sec.id;
    $('#sec-name').value = sec.name;
    $('#sec-grade').value = sec.gradeLevel;
    $('#sec-adviser').value = sec.adviser;
    $('#sec-capacity').value = sec.capacity;

    $('#section-form-title').textContent = `Edit Section — ${sec.name}`;
    $('#section-form-hint').textContent = 'Changes apply immediately to the section. Students currently assigned keep their assignment.';
    $('#sec-submit').textContent = 'Save Changes';
    $('#sec-cancel-edit').style.display = '';
    $('#section-form-card').classList.add('editing');
    $('#section-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exitSectionEditMode() {
    $('#sec-edit-id').value = '';
    $('#section-form').reset();
    $('#section-form-title').textContent = 'Create a Section';
    $('#section-form-hint').textContent = 'Sections organize enrolled students by grade';
    $('#sec-submit').textContent = 'Create Section';
    $('#sec-cancel-edit').style.display = 'none';
    $('#section-form-card').classList.remove('editing');
  }

  function initSectionForm() {
    const grade = $('#sec-grade');
    CFG.GRADE_LEVELS.forEach(g => grade.appendChild(U.el('option', { value: g }, g)));

    $('#sec-cancel-edit').addEventListener('click', exitSectionEditMode);

    $('#section-form').addEventListener('submit', e => {
      e.preventDefault();
      const editingId = $('#sec-edit-id').value;
      const name     = $('#sec-name').value.trim();
      const gradeLevel = $('#sec-grade').value;
      const adviser  = $('#sec-adviser').value.trim();
      const capacity = parseInt($('#sec-capacity').value, 10);

      if (!U.isNonEmpty(name))    return U.toast('Section name required', 'error');
      if (!gradeLevel)            return U.toast('Select a grade level', 'error');
      if (!U.isNonEmpty(adviser)) return U.toast('Adviser name required', 'error');
      if (!U.isPositiveNumber(capacity)) return U.toast('Capacity must be > 0', 'error');

      // Uniqueness check: when editing, a section can't conflict with itself.
      const conflict = Sections.getAll().find(s =>
        s.name.toLowerCase() === name.toLowerCase()
        && s.gradeLevel === gradeLevel
        && s.id !== editingId
      );
      if (conflict) return U.toast('A section with that name already exists for this grade', 'error');

      // -------- EDIT path --------
      if (editingId) {
        Sections.update(editingId, { name, gradeLevel, adviser, capacity });
        logActivity('admin', 'section.edit', `${name} (${gradeLevel})`);
        U.toast(`Section "${name}" updated`, 'success');
        exitSectionEditMode();
        renderSections();
        return;
      }

      // -------- ADD path --------
      const section = {
        id: U.generateId('sec'),
        name, gradeLevel, adviser, capacity,
        createdAt: new Date().toISOString()
      };
      Sections.create(section);
      logActivity('admin', 'section.create', `${name} (${gradeLevel})`);
      U.toast(`Section "${name}" created`, 'success');
      e.target.reset();
      renderSections();
    });
  }

  function deleteSection(id, name) {
    // FK on students.section_id is ON DELETE SET NULL, so removing a section
    // un-assigns any students currently in it (they revert to "approved" with
    // no section). Surface that in the confirm prompt.
    const assigned = Students.getAll().filter(s => s.section === id).length;
    let prompt = `Remove section "${name}"?`;
    if (assigned > 0) {
      prompt += `\n\n${assigned} student${assigned === 1 ? '' : 's'} currently assigned to this section will be un-assigned (their enrollment status moves back to "approved").`;
    }
    if (!confirm(prompt)) return;

    // Reflect the un-assignment in the cache too. The server's FK SET NULL
    // handles the DB side; this keeps the in-memory student copies in sync
    // until the next refresh().
    Students.getAll().forEach(s => {
      if (s.section === id) {
        s.section = null;
        if (s.status === 'enrolled') s.status = 'approved';
      }
    });

    Sections.remove(id);
    logActivity('admin', 'section.remove', name);
    U.toast('Section removed', 'info');
    renderSections();
  }

  function renderSections() {
    const host = $('#sections-list');
    U.clearNode(host);
    const all = Sections.getAll();
    if (!all.length) {
      host.appendChild(U.el('div', { class: 'empty' }, [
        U.el('div', { class: 'ico' }, '✦'),
        U.el('div', { class: 'title' }, 'No sections yet'),
        U.el('div', {}, 'Use the form above to create your first section.')
      ]));
      return;
    }
    const studentsAll = Students.getAll();
    all.slice().sort((a, b) => a.gradeLevel.localeCompare(b.gradeLevel) || a.name.localeCompare(b.name))
      .forEach(sec => {
        const assigned = studentsAll.filter(s => s.section === sec.id).length;
        const pct = Math.min(100, (assigned / sec.capacity) * 100);
        host.appendChild(U.el('div', { class: 'section-card' }, [
          U.el('div', { class: 'info' }, [
            U.el('div', { class: 'name' }, sec.name),
            U.el('div', { class: 'meta' }, `${sec.gradeLevel} · Adviser: ${sec.adviser} · Created ${U.formatDate(sec.createdAt)}`)
          ]),
          U.el('div', { class: 'capacity' }, [
            U.el('div', { class: 'frac' }, `${assigned} / ${sec.capacity}`),
            U.el('div', { class: 'lbl' }, 'Filled'),
            U.el('div', { class: 'bar' }, [U.el('span', { style: `width:${pct}%;` })])
          ]),
          U.el('div', { class: 'actions', style: 'display:flex;gap:6px;align-items:center;margin-left:12px;' }, [
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => enterSectionEditMode(sec)
            }, 'Edit'),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => deleteSection(sec.id, sec.name)
            }, 'Remove')
          ])
        ]));
      });
  }

  // ----------- Assign students -----------
  function populateAssignDropdowns() {
    const studentSel = $('#asg-student');
    const sectionSel = $('#asg-section');
    U.clearNode(studentSel);
    U.clearNode(sectionSel);
    studentSel.appendChild(U.el('option', { value: '' }, '— Select an approved student —'));
    sectionSel.appendChild(U.el('option', { value: '' }, '— Select a section —'));

    Students.getAll()
      .filter(s => s.status === 'approved' || s.status === 'pending')
      .sort((a, b) => fullName(a).localeCompare(fullName(b)))
      .forEach(s => {
        const label = `${fullName(s)} · ${s.gradeLevel} · ${s.status}`;
        studentSel.appendChild(U.el('option', { value: s.id }, label));
      });

    Sections.getAll()
      .sort((a, b) => a.gradeLevel.localeCompare(b.gradeLevel))
      .forEach(sec => {
        const assigned = Students.getAll().filter(s => s.section === sec.id).length;
        const label = `${sec.gradeLevel} — ${sec.name} (${assigned}/${sec.capacity})`;
        sectionSel.appendChild(U.el('option', { value: sec.id }, label));
      });
  }

  function initAssignForm() {
    $('#assign-form').addEventListener('submit', e => {
      e.preventDefault();
      const studentId = $('#asg-student').value;
      const sectionId = $('#asg-section').value;
      if (!studentId || !sectionId) return U.toast('Select both a student and a section', 'error');

      const student = Students.getById(studentId);
      const section = Sections.getById(sectionId);
      if (!student || !section) return U.toast('Selection invalid', 'error');

      if (student.gradeLevel !== section.gradeLevel) {
        return U.toast(`Grade mismatch: student is ${student.gradeLevel}, section is ${section.gradeLevel}`, 'error');
      }

      const occupied = Students.getAll().filter(s => s.section === sectionId).length;
      if (occupied >= section.capacity) return U.toast('Section is at full capacity', 'error');

      Students.update(studentId, { section: sectionId, status: 'enrolled' });
      logActivity('admin', 'student.assign', `${fullName(student)} → ${section.name} (${section.gradeLevel})`);
      U.toast(`${fullName(student)} enrolled to ${section.name}`, 'success');
      e.target.reset();
      populateAssignDropdowns();
      renderAssignedTable();
    });
  }

  function renderAssignedTable() {
    const tbody = $('#assigned-tbl tbody');
    U.clearNode(tbody);
    const list = Students.getAll().filter(s => s.section);
    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.cssText = 'padding:36px; text-align:center; color:var(--ink-500);';
      td.textContent = 'No students assigned to sections yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    list.sort((a, b) => fullName(a).localeCompare(fullName(b))).forEach(s => {
      const sec = Sections.getById(s.section);
      const tr = document.createElement('tr');
      tr.appendChild(U.el('td', { style: 'font-weight:500;' }, fullName(s)));
      tr.appendChild(U.el('td', {}, s.gradeLevel));
      tr.appendChild(U.el('td', {}, sec ? sec.name : '— Removed —'));
      const pillTd = document.createElement('td');
      pillTd.appendChild(U.el('span', { class: 'pill pill-' + s.status }, s.status));
      tr.appendChild(pillTd);

      const actions = U.el('td', { class: 'actions' });
      const removeBtn = U.el('button', {
        class: 'btn btn-danger btn-sm',
        onclick: () => {
          Students.update(s.id, { section: null, status: 'approved' });
          logActivity('admin', 'student.unassign', `${fullName(s)}`);
          U.toast('Student unassigned', 'info');
          renderAssignedTable();
          populateAssignDropdowns();
        }
      }, 'Unassign');
      actions.appendChild(removeBtn);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  // ----------- Faculty Management -----------

  // The form serves both Add and Edit. When `#fac-edit-id` is non-empty,
  // the form is in edit mode: submit calls Faculty.update() instead of
  // Faculty.create(), the title and submit button are relabeled, and a
  // "Cancel edit" button appears.
  function enterFacultyEditMode(fac) {
    $('#fac-edit-id').value = fac.id;
    $('#fac-firstName').value = fac.firstName || '';
    $('#fac-lastName').value = fac.lastName || '';
    $('#fac-position').value = fac.position || '';
    $('#fac-department').value = fac.department || '';
    $('#fac-email').value = fac.email || '';
    $('#fac-contact').value = fac.contact || '';

    // Mirror the existing photo onto the preview + module-scoped pending var.
    // If the user picks a new file the change handler overwrites both.
    const preview = $('#photo-preview');
    U.clearNode(preview);
    if (fac.photoDataUrl) {
      pendingPhotoDataUrl = fac.photoDataUrl;
      const img = document.createElement('img');
      img.src = fac.photoDataUrl;
      preview.appendChild(img);
    } else {
      pendingPhotoDataUrl = null;
      preview.textContent = 'No photo';
    }

    $('#faculty-form-title').textContent = `Edit Faculty — ${facultyFull(fac)}`;
    $('#faculty-form-hint').textContent = 'Leave the photo as-is to keep it, or pick a new one to replace it.';
    $('#fac-submit').textContent = 'Save Changes';
    $('#fac-cancel-edit').style.display = '';
    $('#faculty-form-card').classList.add('editing');
    $('#faculty-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exitFacultyEditMode() {
    $('#fac-edit-id').value = '';
    $('#faculty-form').reset();
    pendingPhotoDataUrl = null;
    const preview = $('#photo-preview');
    U.clearNode(preview);
    preview.textContent = 'No photo';
    $('#faculty-form-title').textContent = 'Add Faculty Member';
    $('#faculty-form-hint').textContent = 'Photos are stored locally as embedded data; replace with cloud uploads when migrating';
    $('#fac-submit').textContent = 'Save Faculty';
    $('#fac-cancel-edit').style.display = 'none';
    $('#faculty-form-card').classList.remove('editing');
  }

  function initFacultyForm() {
    const photoInput = $('#fac-photo');
    const preview = $('#photo-preview');

    photoInput.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        U.toast('Photo must be under 2 MB', 'error');
        photoInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = ev => {
        pendingPhotoDataUrl = ev.target.result;
        U.clearNode(preview);
        const img = document.createElement('img');
        img.src = pendingPhotoDataUrl;
        preview.appendChild(img);
      };
      reader.readAsDataURL(file);
    });

    $('#fac-cancel-edit').addEventListener('click', exitFacultyEditMode);

    $('#faculty-form').addEventListener('submit', e => {
      e.preventDefault();
      const editingId = $('#fac-edit-id').value;
      const data = {
        firstName: $('#fac-firstName').value.trim(),
        lastName:  $('#fac-lastName').value.trim(),
        position:  $('#fac-position').value.trim(),
        department: $('#fac-department').value.trim(),
        email:     $('#fac-email').value.trim(),
        contact:   $('#fac-contact').value.trim()
      };
      for (const k of Object.keys(data)) {
        if (!U.isNonEmpty(data[k])) return U.toast(`Please fill in: ${k}`, 'error');
      }

      // -------- EDIT path --------
      if (editingId) {
        Faculty.update(editingId, {
          ...data,
          photoDataUrl: pendingPhotoDataUrl || null
        });
        logActivity('admin', 'faculty.edit', `${facultyFull(data)} · ${data.position}`);
        U.toast(`Faculty updated: ${facultyFull(data)}`, 'success');
        exitFacultyEditMode();
        renderFaculty($('#fac-search').value);
        return;
      }

      // -------- ADD path --------
      const faculty = {
        id: U.generateId('fac'),
        ...data,
        photoDataUrl: pendingPhotoDataUrl || null,
        createdAt: new Date().toISOString()
      };
      Faculty.create(faculty);
      logActivity('admin', 'faculty.add', `${facultyFull(faculty)} · ${faculty.position}`);
      U.toast(`Faculty added: ${facultyFull(faculty)}`, 'success');
      e.target.reset();
      pendingPhotoDataUrl = null;
      U.clearNode(preview);
      preview.textContent = 'No photo';
      renderFaculty();
    });
  }

  function renderFaculty(filter) {
    const host = $('#faculty-list');
    U.clearNode(host);
    const all = Faculty.getAll();
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? all : all.filter(x =>
      facultyFull(x).toLowerCase().includes(f) ||
      (x.position || '').toLowerCase().includes(f) ||
      (x.department || '').toLowerCase().includes(f)
    );

    if (!list.length) {
      host.appendChild(U.el('div', { class: 'empty' }, [
        U.el('div', { class: 'ico' }, '✦'),
        U.el('div', { class: 'title' }, f ? 'No matches' : 'No faculty members yet'),
        U.el('div', {}, f ? 'Try a different search term.' : 'Use the form above to add the first faculty member.')
      ]));
      return;
    }

    list.sort((a, b) => facultyFull(a).localeCompare(facultyFull(b))).forEach(fac => {
      const photo = U.el('div', { class: 'faculty-photo' });
      if (fac.photoDataUrl) {
        const img = document.createElement('img');
        img.src = fac.photoDataUrl;
        img.alt = facultyFull(fac);
        photo.appendChild(img);
      } else {
        photo.textContent = initials(fac);
      }

      const card = U.el('div', { class: 'faculty-card' }, [
        photo,
        U.el('h4', {}, facultyFull(fac)),
        U.el('div', { class: 'pos' }, fac.position),
        U.el('div', { class: 'dep' }, fac.department),
        U.el('div', { class: 'contact' }, fac.email),
        U.el('div', { class: 'contact' }, fac.contact),
        U.el('div', { style: 'margin-top:8px;display:flex;gap:6px;justify-content:center;' }, [
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => enterFacultyEditMode(fac)
          }, 'Edit'),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => removeFaculty(fac.id, facultyFull(fac))
          }, 'Remove')
        ])
      ]);
      host.appendChild(card);
    });
  }

  function removeFaculty(id, name) {
    if (!confirm(`Remove ${name} from the faculty directory?`)) return;
    Faculty.remove(id);
    logActivity('admin', 'faculty.remove', name);
    U.toast('Faculty removed', 'info');
    renderFaculty($('#fac-search').value);
  }

  // ----------- Activity log -----------
  // Module-scoped filter + pagination state. The filters are read on every
  // render, so changing any control just re-renders. Pagination is page-based
  // (50 entries per page) since the log can grow large.
  const activityState = {
    page: 0,
    pageSize: 50,
    filters: { search: '', role: '', action: '', from: '', to: '' }
  };

  // Get filtered logs (sorted newest-first), independent of pagination.
  function getFilteredActivityLogs() {
    const { search, role, action, from, to } = activityState.filters;
    const s = (search || '').toLowerCase().trim();
    const fromTs = from ? new Date(from + 'T00:00:00').getTime() : null;
    // Inclusive end-of-day on the "to" bound
    const toTs = to ? new Date(to + 'T23:59:59.999').getTime() : null;

    return ActivityLog.getAll()
      .filter(l => {
        if (role && l.role !== role) return false;
        if (action && l.action !== action) return false;
        if (s) {
          const hay = ((l.action || '') + ' ' + (l.details || '')).toLowerCase();
          if (!hay.includes(s)) return false;
        }
        if (fromTs || toTs) {
          const t = new Date(l.timestamp).getTime();
          if (fromTs && t < fromTs) return false;
          if (toTs && t > toTs) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function refreshActionFilter() {
    // The "Action" dropdown is populated from whatever distinct actions
    // exist in the log — easier than hardcoding and stays accurate as new
    // action types appear.
    const sel = $('#activity-action');
    const previous = sel.value;
    const actions = Array.from(new Set(ActivityLog.getAll().map(l => l.action).filter(Boolean))).sort();
    U.clearNode(sel);
    sel.appendChild(U.el('option', { value: '' }, 'All actions'));
    actions.forEach(a => sel.appendChild(U.el('option', { value: a }, a)));
    if (previous && actions.includes(previous)) sel.value = previous;
  }

  function renderActivity() {
    refreshActionFilter();

    const host = $('#activity-list');
    U.clearNode(host);
    const filtered = getFilteredActivityLogs();
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / activityState.pageSize));
    if (activityState.page >= totalPages) activityState.page = totalPages - 1;
    if (activityState.page < 0) activityState.page = 0;
    const start = activityState.page * activityState.pageSize;
    const pageItems = filtered.slice(start, start + activityState.pageSize);

    $('#activity-count-hint').textContent = total === 0
      ? 'No activity matches your filters'
      : `Showing ${start + 1}–${Math.min(start + activityState.pageSize, total)} of ${total} entries`;

    if (!pageItems.length) {
      host.appendChild(U.el('div', { style: 'text-align:center;color:var(--ink-500);padding:32px 0;font-size:0.9rem;' }, 'No activity matches the current filters.'));
    } else {
      pageItems.forEach(l => {
        host.appendChild(U.el('div', { class: 'log-row' }, [
          U.el('div', { class: 'role-tag role-' + l.role }, l.role),
          U.el('div', { class: 'action' }, l.action),
          U.el('div', { class: 'details' }, l.details || '—'),
          U.el('div', { class: 'when' }, U.formatDateTime(l.timestamp))
        ]));
      });
    }

    $('#activity-page-info').textContent = `Page ${activityState.page + 1} of ${totalPages}`;
    $('#activity-prev').disabled = activityState.page === 0;
    $('#activity-next').disabled = activityState.page >= totalPages - 1;
  }

  function initActivityFilters() {
    function rebind(id, evt, key) {
      $(id).addEventListener(evt, e => {
        activityState.filters[key] = e.target.value;
        activityState.page = 0;
        renderActivity();
      });
    }
    rebind('#activity-search', 'input', 'search');
    rebind('#activity-role', 'change', 'role');
    rebind('#activity-action', 'change', 'action');
    rebind('#activity-from', 'change', 'from');
    rebind('#activity-to', 'change', 'to');
    $('#activity-clear').addEventListener('click', () => {
      activityState.filters = { search: '', role: '', action: '', from: '', to: '' };
      activityState.page = 0;
      $('#activity-search').value = '';
      $('#activity-role').value = '';
      $('#activity-action').value = '';
      $('#activity-from').value = '';
      $('#activity-to').value = '';
      renderActivity();
    });
    $('#activity-prev').addEventListener('click', () => {
      activityState.page = Math.max(0, activityState.page - 1);
      renderActivity();
    });
    $('#activity-next').addEventListener('click', () => {
      activityState.page++;
      renderActivity();
    });
  }

  // ----------- Bulk import (Faculty) -----------
  //
  // Faculty bulk import. Mirrors the registrar's structure so the two
  // flows stay easy to keep in sync. See HLC_IMPORT for the underlying
  // alias resolution, file reading, and template generation.

  const IMPORT_ALIASES = {
    faculty: {
      firstName:  ['first name', 'fname', 'given name', 'givenname'],
      lastName:   ['last name', 'lname', 'surname', 'family name', 'familyname'],
      position:   ['title', 'role', 'job title', 'jobtitle', 'designation'],
      department: ['dept', 'team', 'division'],
      email:      ['email address', 'emailaddress', 'e-mail', 'mail'],
      contact:    ['contact number', 'phone', 'phone number', 'phonenumber', 'mobile', 'mobile number', 'cellphone', 'cell', 'tel', 'telephone']
    }
  };

  const IMPORT_VALIDATORS = {
    faculty: (row) => {
      const required = ['firstName', 'lastName', 'position', 'department', 'email', 'contact'];
      for (const k of required) {
        if (row[k] === undefined || row[k] === null || String(row[k]).trim() === '') {
          return { valid: false, error: 'Missing ' + k };
        }
      }
      const email = String(row.email).trim();
      // Simple format check — backend also validates, but failing fast
      // here gives the row-level "X invalid" feedback in the preview.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { valid: false, error: 'Bad email: ' + email };
      }
      return {
        valid: true,
        normalized: {
          firstName:  String(row.firstName).trim(),
          lastName:   String(row.lastName).trim(),
          position:   String(row.position).trim(),
          department: String(row.department).trim(),
          email,
          contact:    String(row.contact).trim()
        }
      };
    }
  };

  const IMPORT_TEMPLATES = {
    faculty: {
      headers: ['firstName', 'lastName', 'position', 'department', 'email', 'contact'],
      samples: [
        { firstName: 'Maria', lastName: 'Santos', position: 'Mathematics Teacher', department: 'Mathematics', email: 'maria.santos@hlc.edu', contact: '09171234567' },
        { firstName: 'Juan',  lastName: 'Reyes',  position: 'English Teacher',     department: 'English',     email: 'juan.reyes@hlc.edu',  contact: '09180000000' }
      ]
    }
  };

  const importCache = { faculty: null };
  const importFiles = { faculty: null };

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

    U.clearNode(previewHost);
    previewHost.style.display = 'block';
    previewHost.appendChild(U.el('h5', {}, 'Preview'));

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
      // Faculty has no optional fields, so any missing canonical IS a problem.
      const row = U.el('div', { style: 'margin-top:6px;' });
      row.appendChild(U.el('strong', {}, 'Missing required: '));
      mapping.missingCanonical.forEach(c => row.appendChild(U.el('span', { class: 'missing-chip' }, c)));
      mappingBox.appendChild(row);
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
    ['Name', 'Position', 'Department', 'Email', 'Status'].forEach(c => headRow.appendChild(U.el('th', {}, c)));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    results.forEach(r => {
      const tr = document.createElement('tr');
      if (!r.valid) tr.className = 'invalid';
      const n = r.normalized || {};
      const a = r.aliased || {};
      tr.appendChild(U.el('td', {}, (n.firstName || a.firstName || '—') + ' ' + (n.lastName || a.lastName || '')));
      tr.appendChild(U.el('td', {}, n.position   || a.position   || '—'));
      tr.appendChild(U.el('td', {}, n.department || a.department || '—'));
      tr.appendChild(U.el('td', {}, n.email      || a.email      || '—'));
      tr.appendChild(U.el('td', {}, r.valid ? '✓' : (r.error || 'invalid')));
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
    valid.forEach(r => {
      Faculty.create({
        id: U.generateId('fac'),
        ...r.normalized,
        photoDataUrl: null,
        createdAt: new Date().toISOString()
      });
      createdCount++;
    });

    logActivity('admin', `import.${kind}`, `${createdCount} created`);
    U.toast(`Imported ${createdCount} ${kind} member(s)`, 'success');

    $('#ta-' + kind).value = '';
    importFiles[kind] = null;
    updateFileName(kind);
    $('#preview-' + kind).style.display = 'none';
    document.querySelector(`[data-import-commit="${kind}"]`).disabled = true;
    importCache[kind] = null;

    if (kind === 'faculty') { renderFaculty(); }
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
    try {
      await previewImport(kind);
    } catch (_) { /* preview already toasted */ }
  }

  function initBulkImport() {
    const xlsxOk = window.HLC_IMPORT && window.HLC_IMPORT.hasXLSXLib();
    if (!xlsxOk) {
      document.querySelectorAll('[data-import-lib-warning]').forEach(el => {
        el.style.display = '';
      });
      document.querySelectorAll('[data-file-pick]').forEach(el => {
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
        const filename = (kind === 'faculty' ? 'faculty-template' : kind + '-template') + '.xlsx';
        window.HLC_IMPORT.downloadTemplate(filename, tpl.headers, tpl.samples);
      });
    });
  }

  // ----------- Boot -----------
  function init() {
    $('#page-meta').textContent = U.formatDateTime(new Date().toISOString());
    $$('.nav-list button').forEach(btn => btn.addEventListener('click', () => setActiveView(btn.dataset.view)));
    $('#fac-search').addEventListener('input', e => renderFaculty(e.target.value));
    initSectionForm();
    initAssignForm();
    initFacultyForm();
    initBulkImport();
    initActivityFilters();
    renderDashboard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
