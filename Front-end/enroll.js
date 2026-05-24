/**
 * enroll.js — controller for the public Online Enrollment form.
 *
 * Deliberately standalone: it does NOT use shared/api.js, storage.js or
 * auth.js, because those assume a signed-in staff user with a JWT. The
 * public form talks to two unauthenticated endpoints directly:
 *
 *   POST /api/online-enrollment/submit          (JSON)  → returns { id }
 *   POST /api/online-enrollment/:id/documents    (multipart) → uploads files
 *
 * Submission is two-phase under the hood (create the record, then upload
 * files against the returned id) but appears as one click to the parent.
 */
(function () {
  'use strict';

  // ── API base. Same default as shared/config.js; change for production. ──
  var API_BASE = 'http://localhost:4000';

  // ── The 8 requirement documents (matches the DB enum + form spec). ──────
  var DOCUMENTS = [
    { type: 'affidavit_of_undertaking', name: 'Affidavit of Undertaking', note: 'PDF or image' },
    { type: 'report_card',              name: 'Report Card',              note: 'PDF or image' },
    { type: 'good_moral',               name: 'Good Moral Certificate',   note: 'PDF or image' },
    { type: 'psa_birth_certificate',    name: 'PSA Birth Certificate',    note: 'Clear scanned copy' },
    { type: 'doctors_advice',           name: "Doctor's Advice",          note: 'If applicable' },
    { type: 'sbt_result',               name: 'SBT Result',               note: 'PDF or image' },
    { type: 'flu_vaccine_certificate',  name: 'Flu Vaccine Certificate',  note: 'PDF or image' },
    { type: 'valid_id',                 name: 'Valid ID',                 note: "Parent / guardian ID" }
  ];

  var $  = function (sel) { return document.querySelector(sel); };
  var byId = function (id) { return document.getElementById(id); };

  // ─── Build the document upload tiles ──────────────────────────────────
  function buildDocTiles() {
    var box = byId('docs');
    DOCUMENTS.forEach(function (d) {
      var tile = document.createElement('div');
      tile.className = 'doc';
      tile.dataset.type = d.type;
      tile.innerHTML =
        '<span class="doc-name">' + d.name + '</span>' +
        '<span class="doc-note">' + d.note + '</span>' +
        '<input type="file" accept="application/pdf,image/*" ' +
        'data-doc="' + d.type + '">' +
        '<span class="picked"></span>';
      box.appendChild(tile);
    });
    box.addEventListener('change', function (e) {
      if (e.target.type !== 'file') return;
      var tile = e.target.closest('.doc');
      var f = e.target.files[0];
      if (f) {
        tile.classList.add('filled');
        tile.querySelector('.picked').textContent =
          '\u2713 ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
      } else {
        tile.classList.remove('filled');
        tile.querySelector('.picked').textContent = '';
      }
    });
  }

  // ─── Age auto-compute from date of birth ──────────────────────────────
  function wireAge() {
    byId('l_birthDate').addEventListener('change', function () {
      var v = this.value;
      var out = byId('l_age');
      if (!v) { out.value = ''; return; }
      var dob = new Date(v), now = new Date();
      var age = now.getFullYear() - dob.getFullYear();
      var m = now.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
      out.value = age >= 0 ? age : '';
    });
  }

  // ─── Shuttle Service conditional logic ────────────────────────────────
  // One-Way Service becomes visible AND required only when shuttle is ON.
  function wireConditional() {
    var toggle = byId('shuttleService');
    var panel  = byId('shuttleFields');
    toggle.addEventListener('change', function () {
      panel.hidden = !this.checked;
      if (!this.checked) {
        byId('carpoolService').value = '';
        clearError('carpoolService');
      }
    });
  }

  // ─── Default the enrollment date to today ─────────────────────────────
  function wireDefaults() {
    var today = new Date().toISOString().slice(0, 10);
    byId('enrollmentDate').value = today;
  }

  // ─── Load the school-year list from the public endpoint ───────────────
  // The active school year (managed by the registrar) is preselected, so
  // the public form defaults to the same value as every other module.
  function loadSchoolYears() {
    var sel = byId('schoolYear');
    fetch(API_BASE + '/api/online-enrollment/school-years')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var years = (data && data.schoolYears) || [];
        var active = data && data.activeSchoolYear;
        sel.innerHTML = '<option value="">Select…</option>';
        years.forEach(function (sy) {
          var o = document.createElement('option');
          o.value = sy; o.textContent = sy;
          if (sy === active) o.selected = true;
          sel.appendChild(o);
        });
        if (!years.length) {
          sel.innerHTML = '<option value="">Select…</option>';
        }
      })
      .catch(function () {
        // Endpoint unreachable — let the parent type nothing rather than
        // showing a stuck "Loading…". The server still validates on submit.
        sel.innerHTML = '<option value="">Select…</option>';
      });
  }

  // ─── Validation helpers ───────────────────────────────────────────────
  function setError(key, msg) {
    var span = document.querySelector('[data-err="' + key + '"]');
    if (span) span.textContent = msg || '';
    var field = byId(key);
    if (field) field.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function clearError(key) { setError(key, ''); }
  function val(id) { return (byId(id).value || '').trim(); }

  // Returns true if a parent block has ANY data entered.
  function parentTouched(prefix) {
    return ['lastName', 'firstName', 'middleName', 'address', 'religion',
            'mobile', 'tel'].some(function (f) { return val(prefix + '_' + f); });
  }

  /**
   * Validate the whole form. Returns { ok, payload } — payload is the JSON
   * body for the submit endpoint. Mirrors the server-side rules so the
   * parent gets instant feedback, but the server re-validates regardless.
   */
  function validate() {
    var errors = 0;
    function need(id, msg) {
      if (!val(id)) { setError(id, msg || 'This field is required'); errors++; }
      else clearError(id);
    }

    // 1. Enrollment info
    need('enrollmentDate'); need('schoolYear'); need('program'); need('gradeLevel');
    // 2. Learner
    need('l_lastName'); need('l_firstName'); need('l_birthDate'); need('l_gender');
    // 3. Shuttle conditional
    if (byId('shuttleService').checked) {
      need('carpoolService');
    }
    // 6. Emergency contact (all required)
    need('e_fullName'); need('e_relationship'); need('e_mobile'); need('e_address');

    // 4/5. Parents — at least one; if a block is touched, key fields required.
    var fT = parentTouched('f'), mT = parentTouched('m');
    if (!fT && !mT) {
      showFormError("Please provide at least one parent's information " +
                    '(Father or Mother).');
      errors++;
    }
    function validateParent(prefix, touched) {
      if (!touched) {
        ['lastName', 'firstName', 'address', 'mobile'].forEach(function (f) {
          clearError(prefix + '_' + f);
        });
        return;
      }
      need(prefix + '_lastName'); need(prefix + '_firstName');
      need(prefix + '_address'); need(prefix + '_mobile');
    }
    validateParent('f', fT);
    validateParent('m', mT);

    if (errors > 0) return { ok: false };

    // Build the JSON payload in the shape the controller expects.
    function parentObj(prefix) {
      return {
        lastName:        val(prefix + '_lastName'),
        firstName:       val(prefix + '_firstName'),
        middleName:      val(prefix + '_middleName'),
        homeAddress:     val(prefix + '_address'),
        religion:        val(prefix + '_religion'),
        mobileNumber:    val(prefix + '_mobile'),
        telephoneNumber: val(prefix + '_tel')
      };
    }
    var payload = {
      schoolYear:     val('schoolYear'),
      program:        val('program'),
      gradeLevel:     val('gradeLevel'),
      enrollmentDate: val('enrollmentDate'),
      learner: {
        lastName:           val('l_lastName'),
        firstName:          val('l_firstName'),
        middleName:         val('l_middleName'),
        birthDate:          val('l_birthDate'),
        gender:             val('l_gender'),
        schoolLastAttended: val('l_school')
      },
      other: {
        shuttleService: byId('shuttleService').checked,
        carpoolService: val('carpoolService'),
        escGrantee:     byId('escGrantee').checked
      },
      emergency: {
        fullName:     val('e_fullName'),
        mobileNumber: val('e_mobile'),
        relationship: val('e_relationship'),
        homeAddress:  val('e_address')
      }
    };
    if (fT) payload.father = parentObj('f');
    if (mT) payload.mother = parentObj('m');

    return { ok: true, payload: payload };
  }

  // ─── Form-level error banner ──────────────────────────────────────────
  function showFormError(msg) {
    var box = byId('form-error');
    box.textContent = msg;
    box.classList.add('show');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideFormError() {
    byId('form-error').classList.remove('show');
  }

  // ─── Submit flow ──────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    hideFormError();

    var result = validate();
    if (!result.ok) {
      if (!byId('form-error').classList.contains('show')) {
        showFormError('Please correct the highlighted fields and try again.');
      }
      return;
    }

    var btn = byId('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      // Phase 1 — create the pending student record.
      var res = await fetch(API_BASE + '/api/online-enrollment/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.payload)
      });
      var data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        // Map server-side field errors back onto the form where possible.
        if (data.details && typeof data.details === 'object') {
          Object.keys(data.details).forEach(function (k) {
            var el = document.querySelector('[data-err="' + k + '"]');
            if (el) el.textContent = data.details[k];
          });
        }
        throw new Error(data.error || 'Submission failed. Please try again.');
      }

      // Phase 2 — upload any chosen documents against the new id.
      var fileInputs = document.querySelectorAll('#docs input[type=file]');
      var fd = new FormData();
      var hasFiles = false;
      fileInputs.forEach(function (inp) {
        if (inp.files && inp.files[0]) {
          // The field name IS the document type — the server keys off it.
          fd.append(inp.dataset.doc, inp.files[0]);
          hasFiles = true;
        }
      });
      if (hasFiles) {
        var up = await fetch(
          API_BASE + '/api/online-enrollment/' + data.id + '/documents',
          { method: 'POST', body: fd }   // no Content-Type — browser sets boundary
        );
        if (!up.ok) {
          var upErr = await up.json().catch(function () { return {}; });
          // The record was created; only the files failed. Tell the parent
          // plainly rather than silently losing the upload.
          throw new Error(
            (upErr.error || 'Documents could not be uploaded.') +
            ' Your form was received — please bring the documents to the ' +
            'registrar\u2019s office.'
          );
        }
      }

      // Success — swap the form for the confirmation panel.
      byId('enroll-form').style.display = 'none';
      byId('refChip').textContent = data.id;
      byId('success').classList.add('show');
      window.scrollTo({ top: 0, behavior: 'smooth' });

    } catch (err) {
      showFormError(err && err.message ? err.message :
                    'Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Submit Enrollment';
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Render the real school logo — same single source of truth as the rest
    // of the modules (shared/logo.js → assets/images/Logo.png).
    if (window.HLC_LOGO && typeof window.HLC_LOGO.renderLogo === 'function') {
      window.HLC_LOGO.renderLogo('#enroll-logo', { withOpacity: false });
    }
    buildDocTiles();
    wireAge();
    wireConditional();
    wireDefaults();
    loadSchoolYears();
    byId('enroll-form').addEventListener('submit', handleSubmit);

    // Clear a field's error as the user fixes it.
    document.addEventListener('input', function (e) {
      if (e.target.id) clearError(e.target.id);
    });
  });
})();
