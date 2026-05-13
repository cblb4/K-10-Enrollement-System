/**
 * cashier.js
 * Cashier workflows: payment collection, dues, history, plus Charges & Fees
 * management (one-off charges, misc fees catalog, optional fee application).
 *
 * Scope (financial-only)
 * ----------------------
 * The cashier handles money: defining fees, billing students, collecting
 * payments, recording receipts, monitoring outstanding balances, and keeping
 * the transaction history. The cashier does NOT view a student's curriculum
 * or schedule — that lives in the registrar module under "Student GSA",
 * which renders the academic side of the same student.charges[] array
 * (subjects + applied fee names, no amounts).
 *
 * The cashier still reads student.charges[] to compute balances, but only
 * the billable rows (source !== 'subject'). Subject curriculum entries are
 * registrar-only.
 */
(function () {
  'use strict';

  // Auth guard
  const me = window.HLC_AUTH.requireRole('cashier', '../../auth.html');
  if (!me) return;

  const {
    Students, Payments, recordPayment, logActivity,
    addCharge, MiscFees, applyMiscFee, applySchoolWideFees,
    voidPayment, editMiscFee, getActiveSchoolYear, setActiveSchoolYear
  } = window.HLC_STORAGE;
  const U = window.HLC_UTILS;
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

  // ----------- View routing -----------
  function setActiveView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-list button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    const titles = {
      dashboard: ['Finance', 'Dashboard'],
      charges:   ['Billing', 'Charges & Fees'],
      collect:   ['Transaction', 'Collect Payment'],
      dues:      ['Receivables', 'Outstanding Dues'],
      history:   ['Records', 'Payment History']
    };
    const [eyebrow, title] = titles[name] || titles.dashboard;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    if (name === 'dashboard') renderDashboard();
    if (name === 'charges')   { populateChargeStudentDropdown(); renderChargesTable(); refreshSchoolYearBanner(); renderMiscFeesList(); }
    if (name === 'collect')   populateCollectStudents();
    if (name === 'dues')      renderDues();
    if (name === 'history')   renderHistory();
  }

  // ----------- Dashboard -----------
  function renderDashboard() {
    const allStudents = Students.getAll();
    const allPayments = Payments.getAll();

    const totalCollected = allPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const totalCharges = allStudents.reduce((s, st) => s + U.sumCharges(st), 0);
    const outstanding = allStudents.reduce((s, st) => s + U.sumUnpaidCharges(st), 0);
    const txCount = allPayments.length;

    const stats = $('#cash-stats');
    U.clearNode(stats);
    [
      { label: 'Total Collected', value: U.formatCurrency(totalCollected), gold: true },
      { label: 'Outstanding',     value: U.formatCurrency(outstanding) },
      { label: 'Total Billed',    value: U.formatCurrency(totalCharges) },
      { label: 'Transactions',    value: String(txCount) }
    ].forEach(t => {
      stats.appendChild(U.el('div', { class: 'stat' + (t.gold ? ' gold' : '') }, [
        U.el('div', { class: 'label' }, t.label),
        U.el('div', { class: 'value' }, t.value)
      ]));
    });

    const tbody = $('#recent-pay-tbl tbody');
    U.clearNode(tbody);
    const recent = allPayments.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
    if (!recent.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.cssText = 'text-align:center; padding:32px; color:var(--ink-500);';
      td.textContent = 'No payments recorded yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    recent.forEach(p => {
      const s = Students.getById(p.studentId);
      const tr = document.createElement('tr');
      tr.appendChild(U.el('td', { style: 'font-family:var(--font-display);font-weight:600;color:var(--maroon-800);' }, p.id.slice(-8).toUpperCase()));
      tr.appendChild(U.el('td', {}, s ? fullName(s) : '— Deleted —'));
      tr.appendChild(U.el('td', {}, p.method));
      tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(p.amount)));
      tr.appendChild(U.el('td', {}, U.formatDateTime(p.createdAt)));
      tbody.appendChild(tr);
    });
  }

  // ----------- Collect payment -----------
  function populateCollectStudents() {
    const sel = $('#pay-student');
    const current = sel.value;
    U.clearNode(sel);
    sel.appendChild(U.el('option', { value: '' }, '— Select a student with charges —'));
    // Only include students who have at least one billable (non-subject) charge.
    // Subjects are zero-amount curriculum records under K–10 fixed tuition and
    // can't be settled at the cashier, so a student with only subject charges
    // shouldn't appear in this dropdown.
    const studentsWithCharges = Students.getAll().filter(s =>
      Array.isArray(s.charges) && s.charges.some(c => c.source !== 'subject')
    );
    if (!studentsWithCharges.length) {
      sel.appendChild(U.el('option', { value: '', disabled: 'disabled' }, 'No students have charges yet'));
      $('#pay-summary').style.display = 'none';
      $('#pay-form').style.display = 'none';
      return;
    }
    studentsWithCharges
      .sort((a, b) => fullName(a).localeCompare(fullName(b)))
      .forEach(s => {
        const unpaid = U.sumUnpaidCharges(s);
        const label = `${fullName(s)} · ${s.gradeLevel} · Due: ${U.formatCurrency(unpaid)}`;
        sel.appendChild(U.el('option', { value: s.id }, label));
      });
    if (current) sel.value = current;
  }

  function renderPaySummary(student) {
    const summary = $('#pay-summary');
    summary.style.display = 'block';
    U.clearNode(summary);

    const total = U.sumCharges(student);
    const paid  = U.sumPaidCharges(student);
    const due   = total - paid;

    summary.appendChild(U.el('div', { class: 'name' }, fullName(student)));
    summary.appendChild(U.el('div', { class: 'meta' }, `${student.gradeLevel} · Guardian: ${student.guardianName}`));
    summary.appendChild(U.el('div', { class: 'totals' }, [
      U.el('div', { class: 'item' }, [U.el('div', { class: 'lbl' }, 'Total Charges'), U.el('div', { class: 'val' }, U.formatCurrency(total))]),
      U.el('div', { class: 'item' }, [U.el('div', { class: 'lbl' }, 'Paid'),          U.el('div', { class: 'val' }, U.formatCurrency(paid))]),
      U.el('div', { class: 'item' }, [U.el('div', { class: 'lbl' }, 'Outstanding'),   U.el('div', { class: 'val' }, U.formatCurrency(due))])
    ]));
  }

  function renderChargeChecklist(student) {
    const host = $('#charge-checklist');
    U.clearNode(host);
    // Subjects are curriculum records (zero-amount under K–10 fixed tuition)
    // and never billable, so we keep them out of the payment checklist.
    const billable = student.charges.filter(c => c.source !== 'subject');
    if (!billable.length) {
      host.appendChild(U.el('div', {
        style: 'padding:18px; text-align:center; color:var(--ink-500); font-size:0.88rem;'
      }, 'No billable charges on this account.'));
      return;
    }

    // Split carry-over charges (from previous term) from current-term charges
    // so the cashier can clearly see what's an old obligation vs. what's new.
    // Carry-over items render first, in their own group, with a visible label
    // that includes the original grade/SY they came from.
    const carryOver = billable.filter(c => c.isCarryOver);
    const current = billable.filter(c => !c.isCarryOver);

    if (carryOver.length) {
      // Group carry-over items by their original term so a student promoted
      // multiple times reads cleanly.
      const groups = {};
      carryOver.forEach(c => {
        const key = `${c.originalGradeLevel || '—'} · SY ${c.originalSchoolYear || '—'}`;
        (groups[key] = groups[key] || []).push(c);
      });
      Object.keys(groups).sort().forEach(key => {
        host.appendChild(U.el('div', { class: 'checklist-group-label carry' },
          `Previous balance — ${key}`
        ));
        groups[key].forEach(c => host.appendChild(buildChecklistRow(c, true)));
      });
    }

    if (current.length) {
      if (carryOver.length) {
        host.appendChild(U.el('div', { class: 'checklist-group-label' }, 'Current term'));
      }
      current.forEach(c => host.appendChild(buildChecklistRow(c, false)));
    }
  }

  function buildChecklistRow(c, isCarry) {
    const isPaid = c.status === 'paid';
    const classes = ['check-row'];
    if (isPaid) classes.push('paid');
    if (isCarry) classes.push('check-row-carry');
    const row = U.el('label', { class: classes.join(' '), 'data-charge-id': c.chargeId });
    const cb = U.el('input', {
      type: 'checkbox',
      value: c.chargeId,
      'data-amount': c.amount
    });
    if (isPaid) cb.disabled = true;
    cb.addEventListener('change', updateTotalDisplay);
    row.appendChild(cb);
    row.appendChild(U.el('div', {}, [
      U.el('div', { class: 'ttl' }, c.title),
      c.description ? U.el('div', { class: 'desc' }, c.description) : null
    ].filter(Boolean)));
    row.appendChild(U.el('div', { class: 'amt' }, U.formatCurrency(c.amount)));
    row.appendChild(U.el('span', { class: 'pill pill-' + c.status }, c.status));
    return row;
  }

  /**
   * Compute the active discount in pesos given the selected charges.
   * Returns { amount, percent (or null), label }. If no discount applied,
   * amount is 0.
   */
  function readDiscountInputs(chargesTotal) {
    const type = (document.querySelector('input[name="disc-type"]:checked') || {}).value || 'none';
    const label = ($('#disc-label').value || '').trim();
    if (type === 'percent') {
      const pct = Math.max(0, Math.min(100, Number($('#disc-percent').value) || 0));
      const amount = Math.round((chargesTotal * (pct / 100)) * 100) / 100;
      return { amount, percent: pct, label, type };
    }
    if (type === 'amount') {
      const amount = Math.max(0, Number($('#disc-amount').value) || 0);
      return { amount, percent: null, label, type };
    }
    return { amount: 0, percent: null, label: '', type: 'none' };
  }

  function updateTotalDisplay() {
    const checks = $$('#charge-checklist input[type="checkbox"]:checked');
    const chargesTotal = checks.reduce((s, c) => s + (Number(c.dataset.amount) || 0), 0);
    const disc = readDiscountInputs(chargesTotal);

    // Cap discount at chargesTotal (can't discount more than the bill)
    const discAmount = Math.min(disc.amount, chargesTotal);
    const cashToReceive = Math.max(0, chargesTotal - discAmount);

    $('#pay-charges-total').textContent = U.formatCurrency(chargesTotal);
    $('#pay-total').textContent = U.formatCurrency(cashToReceive);

    const discRow = $('#pay-discount-row');
    if (discAmount > 0) {
      discRow.style.display = 'flex';
      const labelText = disc.type === 'percent'
        ? `Discount (${disc.percent}%${disc.label ? ' · ' + disc.label : ''})`
        : `Discount${disc.label ? ' (' + disc.label + ')' : ''}`;
      $('#pay-discount-label').textContent = labelText;
      $('#pay-discount-val').textContent = '−' + U.formatCurrency(discAmount);
    } else {
      discRow.style.display = 'none';
    }

    // Visual flag if user typed more than the bill
    const overflow = disc.amount > chargesTotal && chargesTotal > 0;
    document.querySelector('.discount-block')?.classList.toggle('overflow', overflow);
  }

  function initDiscountControls() {
    // Radio toggle: show/hide the relevant inputs
    document.querySelectorAll('input[name="disc-type"]').forEach(r => {
      r.addEventListener('change', () => {
        const type = r.value;
        $('#disc-percent-wrap').style.display = type === 'percent' ? 'flex' : 'none';
        $('#disc-amount-wrap').style.display  = type === 'amount'  ? 'flex' : 'none';
        $('#disc-label-wrap').style.display   = type !== 'none'    ? 'flex' : 'none';
        if (type === 'none') {
          $('#disc-percent').value = '';
          $('#disc-amount').value = '';
          $('#disc-label').value = '';
        }
        updateTotalDisplay();
      });
    });
    // Live recalc as the cashier types
    ['#disc-percent', '#disc-amount'].forEach(sel => {
      $(sel).addEventListener('input', updateTotalDisplay);
    });
  }

  function initCollect() {
    initDiscountControls();

    $('#pay-student').addEventListener('change', e => {
      const id = e.target.value;
      const form = $('#pay-form');
      if (!id) { $('#pay-summary').style.display = 'none'; form.style.display = 'none'; return; }
      const student = Students.getById(id);
      if (!student) return;
      renderPaySummary(student);
      renderChargeChecklist(student);
      form.style.display = 'block';
      // Reset discount UI when switching students
      const noneRadio = document.querySelector('input[name="disc-type"][value="none"]');
      if (noneRadio) {
        noneRadio.checked = true;
        noneRadio.dispatchEvent(new Event('change'));
      }
      updateTotalDisplay();
    });

    $('#pay-form').addEventListener('submit', e => {
      e.preventDefault();
      const studentId = $('#pay-student').value;
      const method    = $('#pay-method').value;
      const reference = $('#pay-reference').value.trim();
      const receivedBy = $('#pay-receivedBy').value.trim();

      const checks = $$('#charge-checklist input[type="checkbox"]:checked');
      if (!checks.length) return U.toast('Select at least one charge to settle', 'error');
      if (!method)        return U.toast('Choose a payment method', 'error');
      if (!receivedBy)    return U.toast('Enter the cashier name', 'error');

      const chargeIds = checks.map(c => c.value);
      const chargesTotal = checks.reduce((s, c) => s + (Number(c.dataset.amount) || 0), 0);

      const disc = readDiscountInputs(chargesTotal);
      if (disc.amount > chargesTotal) {
        return U.toast(`Discount (${U.formatCurrency(disc.amount)}) cannot exceed selected charges (${U.formatCurrency(chargesTotal)})`, 'error');
      }
      if (disc.amount > 0 && !disc.label) {
        return U.toast('Please add a reason / label for the discount', 'error');
      }

      const cashAmount = chargesTotal - disc.amount;

      const payment = recordPayment(studentId, {
        amount: cashAmount,
        method,
        reference,
        chargeIds,
        receivedBy,
        discountAmount: disc.amount,
        discountLabel: disc.label,
        discountPercent: disc.percent
      });
      if (!payment) return U.toast('Payment failed', 'error');

      const refreshed = Students.getById(studentId);
      const due = U.sumUnpaidCharges(refreshed);
      const paid = U.sumPaidCharges(refreshed);
      const total = U.sumCharges(refreshed);
      let pStatus = 'unpaid';
      if (due === 0 && total > 0) pStatus = 'paid';
      else if (paid > 0) pStatus = 'partial';
      Students.update(studentId, { paymentStatus: pStatus });

      const logMsg = disc.amount > 0
        ? `${fullName(refreshed)} · ${U.formatCurrency(cashAmount)} (− ${U.formatCurrency(disc.amount)} discount: ${disc.label}) · ${method}`
        : `${fullName(refreshed)} · ${U.formatCurrency(cashAmount)} · ${method}`;
      logActivity('cashier', 'payment.record', logMsg);

      const toastMsg = disc.amount > 0
        ? `Payment recorded: ${U.formatCurrency(cashAmount)} (discount ${U.formatCurrency(disc.amount)} applied)`
        : `Payment recorded: ${U.formatCurrency(cashAmount)}`;
      U.toast(toastMsg, 'success');

      showReceipt(payment, refreshed);

      e.target.reset();
      $('#pay-summary').style.display = 'none';
      $('#pay-form').style.display = 'none';
      $('#pay-student').value = '';
      // Reset discount UI for next transaction
      const noneRadio2 = document.querySelector('input[name="disc-type"][value="none"]');
      if (noneRadio2) {
        noneRadio2.checked = true;
        noneRadio2.dispatchEvent(new Event('change'));
      }
      populateCollectStudents();
    });
  }

  // ----------- Receipt modal -----------
  function showReceipt(payment, student) {
    const body = $('#receipt-body');
    U.clearNode(body);

    body.appendChild(U.el('div', { class: 'rcpt-hdr' }, [
      U.el('div', { class: 'school' }, 'Heartworks Learning Center'),
      U.el('div', { class: 'sub' }, 'Official Payment Receipt')
    ]));

    body.appendChild(U.el('div', { class: 'rcpt-grid' }, [
      U.el('div', { class: 'lbl' }, 'Receipt #'),
      U.el('div', { class: 'val' }, payment.id.slice(-10).toUpperCase()),
      U.el('div', { class: 'lbl' }, 'Date'),
      U.el('div', { class: 'val' }, U.formatDateTime(payment.createdAt)),
      U.el('div', { class: 'lbl' }, 'Student'),
      U.el('div', { class: 'val' }, fullName(student)),
      U.el('div', { class: 'lbl' }, 'Grade'),
      U.el('div', { class: 'val' }, student.gradeLevel),
      U.el('div', { class: 'lbl' }, 'Method'),
      U.el('div', { class: 'val' }, payment.method),
      U.el('div', { class: 'lbl' }, 'Reference'),
      U.el('div', { class: 'val' }, payment.reference || '—'),
      U.el('div', { class: 'lbl' }, 'Received By'),
      U.el('div', { class: 'val' }, payment.receivedBy)
    ]));

    const items = U.el('div', { class: 'rcpt-items' });
    student.charges
      .filter(c => payment.chargeIds.includes(c.chargeId))
      .forEach(c => {
        items.appendChild(U.el('div', { class: 'row' }, [
          U.el('span', {}, c.title),
          U.el('span', {}, U.formatCurrency(c.amount))
        ]));
      });
    body.appendChild(items);

    // If a discount was applied, show the breakdown clearly so the
    // receipt holder can see how the cash amount was reached.
    const discountAmount = Number(payment.discountAmount) || 0;
    if (discountAmount > 0) {
      const chargesSum = student.charges
        .filter(c => payment.chargeIds.includes(c.chargeId))
        .reduce((t, c) => t + (Number(c.amount) || 0), 0);
      const discLabel = payment.discountPercent
        ? `Discount (${payment.discountPercent}%${payment.discountLabel ? ' · ' + payment.discountLabel : ''})`
        : `Discount${payment.discountLabel ? ' (' + payment.discountLabel + ')' : ''}`;

      body.appendChild(U.el('div', { class: 'rcpt-items', style: 'margin-top:8px;' }, [
        U.el('div', { class: 'row', style: 'color:var(--ink-500);font-size:0.85rem;' }, [
          U.el('span', {}, 'Sub-total'),
          U.el('span', {}, U.formatCurrency(chargesSum))
        ]),
        U.el('div', { class: 'row', style: 'color:var(--success);' }, [
          U.el('span', {}, discLabel),
          U.el('span', {}, '−' + U.formatCurrency(discountAmount))
        ])
      ]));
    }

    body.appendChild(U.el('div', { class: 'rcpt-total' }, [
      U.el('span', {}, 'Cash Received'),
      U.el('span', {}, U.formatCurrency(payment.amount))
    ]));

    $('#receipt-modal').classList.add('open');
  }

  // ----------- Dues -----------
  function renderDues(filter) {
    const tbody = $('#dues-tbl tbody');
    U.clearNode(tbody);

    const all = Students.getAll().filter(s => U.sumCharges(s) > 0);
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? all : all.filter(s =>
      fullName(s).toLowerCase().includes(f) ||
      (s.gradeLevel || '').toLowerCase().includes(f)
    );

    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.style.cssText = 'padding:40px; text-align:center; color:var(--ink-500);';
      td.textContent = 'No outstanding accounts.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    list.sort((a, b) => U.sumUnpaidCharges(b) - U.sumUnpaidCharges(a)).forEach(s => {
      const total = U.sumCharges(s);
      const paid = U.sumPaidCharges(s);
      const due = total - paid;
      let status = 'unpaid';
      if (due === 0) status = 'paid';
      else if (paid > 0) status = 'partial';

      // Compute the unpaid carry-over portion so the cashier can tell at a
      // glance how much of this student's outstanding balance is rolled over
      // from a previous term vs. owed for the current term.
      const carryOverDue = (s.charges || [])
        .filter(c => c.isCarryOver && c.status !== 'paid')
        .reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

      const tr = document.createElement('tr');
      tr.appendChild(U.el('td', {}, [
        U.el('div', { style: 'font-weight:500;' }, fullName(s)),
        U.el('div', { style: 'font-size:0.78rem;color:var(--ink-500);' }, s.guardianName)
      ]));
      tr.appendChild(U.el('td', {}, s.gradeLevel));
      tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(total)));
      tr.appendChild(U.el('td', { class: 'numeric', style: 'color:var(--success);' }, U.formatCurrency(paid)));

      // Outstanding cell — show the total due, plus a small "incl. carry-over"
      // line when a portion of the balance is from a previous term.
      const outstandingCell = U.el('td', { class: 'numeric', style: 'font-weight:600;color:' + (due > 0 ? 'var(--danger)' : 'var(--ink-500)') + ';' });
      outstandingCell.appendChild(document.createTextNode(U.formatCurrency(due)));
      if (carryOverDue > 0) {
        outstandingCell.appendChild(U.el('div', {
          style: 'font-size:0.7rem; font-weight:500; color:var(--ink-500); margin-top:2px;'
        }, `incl. ${U.formatCurrency(carryOverDue)} carry-over`));
      }
      tr.appendChild(outstandingCell);

      const pillTd = document.createElement('td');
      pillTd.appendChild(U.el('span', { class: 'pill pill-' + status }, status));
      tr.appendChild(pillTd);
      tbody.appendChild(tr);
    });
  }

  // ----------- History -----------
  function renderHistory(filter) {
    const tbody = $('#hist-tbl tbody');
    U.clearNode(tbody);
    const payments = Payments.getAll().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const f = (filter || '').toLowerCase().trim();
    const list = !f ? payments : payments.filter(p => {
      const s = Students.getById(p.studentId);
      const name = s ? fullName(s) : '';
      return name.toLowerCase().includes(f) || (p.method || '').toLowerCase().includes(f);
    });

    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.style.cssText = 'padding:40px; text-align:center; color:var(--ink-500);';
      td.textContent = 'No payment history.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    list.forEach(p => {
      const s = Students.getById(p.studentId);
      const tr = document.createElement('tr');
      if (p.voidedAt) tr.classList.add('row-voided');
      tr.appendChild(U.el('td', { style: 'font-family:var(--font-display);font-weight:600;color:var(--maroon-800);' }, p.id.slice(-10).toUpperCase()));
      tr.appendChild(U.el('td', {}, s ? fullName(s) : '— Deleted —'));
      tr.appendChild(U.el('td', {}, p.method));
      tr.appendChild(U.el('td', { style: 'color:var(--ink-500);' }, p.reference || '—'));
      tr.appendChild(U.el('td', {}, p.receivedBy));
      tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(p.amount)));
      tr.appendChild(U.el('td', {}, U.formatDateTime(p.createdAt)));

      const actionCell = U.el('td', { class: 'actions' });
      if (p.voidedAt) {
        const reason = p.voidReason ? ` — ${p.voidReason}` : '';
        actionCell.appendChild(U.el('span', {
          class: 'pill pill-voided',
          title: `Voided ${U.formatDateTime(p.voidedAt)}${p.voidedBy ? ' by ' + p.voidedBy : ''}${reason}`
        }, 'Voided'));
      } else {
        actionCell.appendChild(U.el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => openVoidModal(p.id)
        }, 'Void'));
      }
      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    });
  }

  // ----------- Charges & Fees: shared helper -----------
  // Used by both renderChargesTable and renderMiscFeesList for empty-state rendering.
  function emptyState(title, msg) {
    return U.el('div', { class: 'empty' }, [
      U.el('div', { class: 'ico' }, '✦'),
      U.el('div', { class: 'title' }, title),
      U.el('div', {}, msg)
    ]);
  }

  // ----------- One-Off Charges: form & table -----------
  function populateChargeStudentDropdown() {
    const sel = $('#charge-student');
    const current = sel.value;
    U.clearNode(sel);
    sel.appendChild(U.el('option', { value: '' }, '— Select a student —'));
    Students.getAll()
      .slice()
      .sort((a, b) => fullName(a).localeCompare(fullName(b)))
      .forEach(s => {
        sel.appendChild(U.el('option', { value: s.id }, `${fullName(s)} · ${s.gradeLevel}`));
      });
    if (current) sel.value = current;
  }

  function initChargeForm() {
    $('#charge-form').addEventListener('submit', e => {
      e.preventDefault();
      const studentId = $('#charge-student').value;
      const title  = $('#charge-title').value.trim();
      const amount = $('#charge-amount').value;
      const desc   = $('#charge-desc').value.trim();

      if (!studentId)                       return U.toast('Select a student', 'error');
      if (!U.isNonEmpty(title))             return U.toast('Charge title is required', 'error');
      if (!U.isPositiveNumber(amount))      return U.toast('Amount must be greater than zero', 'error');

      const result = addCharge(studentId, { title, amount, description: desc, source: 'manual' });
      if (!result) return U.toast('Failed to add charge', 'error');

      logActivity('cashier', 'charge.add', `${title} · ${U.formatCurrency(amount)}`);
      U.toast(`Charge added: ${title}`, 'success');
      e.target.reset();
      renderChargesTable();
    });
  }

  function renderChargesTable(filter) {
    const tbody = $('#charges-tbl tbody');
    U.clearNode(tbody);
    const all = Students.getAll();
    const rows = [];
    all.forEach(s => {
      (s.charges || []).forEach(c => rows.push({ student: s, charge: c }));
    });

    const f = (filter || '').toLowerCase().trim();
    const filtered = !f ? rows : rows.filter(r =>
      fullName(r.student).toLowerCase().includes(f) ||
      (r.charge.title || '').toLowerCase().includes(f)
    );

    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.appendChild(emptyState('No charges yet', 'Subject assignments and miscellaneous charges will appear here.'));
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    filtered.sort((a, b) => new Date(b.charge.createdAt) - new Date(a.charge.createdAt))
      .forEach(({ student, charge }) => {
        const tr = document.createElement('tr');
        if (charge.isCarryOver) tr.classList.add('row-carry');
        tr.appendChild(U.el('td', {}, [
          U.el('div', { style: 'font-weight:500;' }, fullName(student)),
          U.el('div', { style: 'font-size:0.78rem;color:var(--ink-500);' }, student.gradeLevel)
        ]));
        // Title cell — append a small carry-over note when applicable so
        // the cashier can tell at a glance which rows are previous-term debt.
        const titleCell = U.el('td', {}, charge.title);
        if (charge.isCarryOver) {
          titleCell.appendChild(U.el('div', {
            style: 'font-size:0.7rem; color:var(--ink-500); margin-top:2px;'
          }, `Carry-over · ${charge.originalGradeLevel || '—'} · SY ${charge.originalSchoolYear || '—'}`));
        }
        tr.appendChild(titleCell);
        // Source label: subject / school-wide / optional / manual
        let srcLabel = 'Manual', srcStyle = 'background:var(--paper); color: var(--ink-500)';
        if (charge.source === 'subject') {
          srcLabel = 'Subject';
          srcStyle = 'background:rgba(168, 132, 42, 0.15); color: var(--gold-700)';
        } else if (charge.source === 'misc-fee') {
          if (charge.feeScope === 'school') {
            srcLabel = 'School-wide';
            srcStyle = 'background:rgba(61, 13, 17, 0.08); color: var(--maroon-900)';
          } else {
            srcLabel = 'Optional';
            srcStyle = 'background:rgba(168, 132, 42, 0.10); color: var(--gold-700)';
          }
        }
        tr.appendChild(U.el('td', {}, [
          U.el('span', {
            style: 'font-size:0.75rem; padding:2px 8px; border-radius:4px; ' + srcStyle
          }, srcLabel)
        ]));
        tr.appendChild(U.el('td', { class: 'numeric' }, U.formatCurrency(charge.amount)));
        const pillTd = document.createElement('td');
        pillTd.appendChild(U.el('span', { class: 'pill pill-' + charge.status }, charge.status));
        tr.appendChild(pillTd);
        tr.appendChild(U.el('td', {}, U.formatDate(charge.createdAt)));
        tbody.appendChild(tr);
      });
  }

  // ----------- Misc Fees catalog -----------
  // Adds/lists/removes miscellaneous fee definitions. School-wide fees
  // auto-apply to every newly enrolled student; optional fees are picked
  // per student via the "Apply Fee" button.

  // ----- Audience-overlap helpers (used by the duplicate-name check) -----
  //
  // Two fees "overlap" if there's any student who could end up holding both
  // of them on their GSA. We use this to decide whether two same-named fees
  // are genuinely conflicting or just innocuous reuse across disjoint
  // audiences.
  //
  // School-year guard: fees in different school years never overlap, even if
  // their scope/grades match — different SYs target different student
  // cohorts, so two "Tuition" fees (one for SY 2024-25, one for SY 2025-26)
  // never collide on a single student's GSA.
  //
  // Within the same school year:
  //   school    ↔ school    : overlap (everyone)
  //   school    ↔ grades    : overlap (school covers every grade)
  //   school    ↔ optional  : no overlap (optional is opt-in, won't auto-collide)
  //   grades    ↔ grades    : overlap iff their gradeLevels share at least one entry
  //   grades    ↔ optional  : no overlap
  //   optional  ↔ optional  : overlap (would create twin entries in the per-student picker)
  function audiencesOverlap(a, b) {
    const aSY = a.schoolYear || getActiveSchoolYear();
    const bSY = b.schoolYear || getActiveSchoolYear();
    if (aSY !== bSY) return false;
    if (a.scope === 'optional' && b.scope === 'optional') return true;
    if (a.scope === 'optional' || b.scope === 'optional') return false;
    if (a.scope === 'school' || b.scope === 'school') return true;
    // Both are 'grades' — check intersection
    const setA = new Set(a.gradeLevels || []);
    return (b.gradeLevels || []).some(g => setA.has(g));
  }

  // Returns the conflicting fee, or null if the name is safe to use.
  // ignoreId lets the caller skip a particular fee (useful when editing).
  function findNameConflict(name, scope, gradeLevels, schoolYear, ignoreId) {
    const target = name.trim().toLowerCase();
    const candidate = { scope, gradeLevels: gradeLevels || [], schoolYear: schoolYear || getActiveSchoolYear() };
    return MiscFees.getAll().find(f =>
      f.id !== ignoreId &&
      f.name.toLowerCase() === target &&
      audiencesOverlap(candidate, { scope: f.scope, gradeLevels: f.gradeLevels || [], schoolYear: f.schoolYear })
    ) || null;
  }

  // Build a clear error message that explains *why* the name is rejected
  // and points at exactly which existing fee it conflicts with.
  function buildConflictMessage(existingFee, newScope, newGrades) {
    const existingScope = existingFee.scope;
    const existingGrades = existingFee.gradeLevels || [];

    if (existingScope === 'optional' && newScope === 'optional') {
      return `An optional fee named "${existingFee.name}" already exists for this school year`;
    }
    if (existingScope === 'school' && newScope === 'school') {
      return `A school-wide fee named "${existingFee.name}" already exists for this school year`;
    }
    if (existingScope === 'school') {
      return `"${existingFee.name}" is already defined school-wide for this year — it would double-apply for every grade you pick`;
    }
    if (newScope === 'school') {
      return `"${existingFee.name}" is already defined for ${existingGrades.join(', ')} this year — making it school-wide would double-apply to those students`;
    }
    // Both grades — find the overlapping grades to show the user
    const overlap = existingGrades.filter(g => (newGrades || []).includes(g));
    return `"${existingFee.name}" already covers ${overlap.join(', ')} this year — pick a different name or a non-overlapping grade`;
  }

  // -------- School year helpers (shared across views) --------
  // The catalog can be filtered to a particular school year. Default is the
  // active SY. Stored at module scope so renderMiscFeesList() can read it.
  let catalogYearFilter = null; // null means "use active SY"

  // Returns sorted unique list of school years that exist in the data,
  // plus the active SY (which is always present even if no fees exist for it).
  function getSchoolYearList() {
    const set = new Set();
    set.add(getActiveSchoolYear());
    MiscFees.getAll().forEach(f => { if (f.schoolYear) set.add(f.schoolYear); });
    Students.getAll().forEach(s => { if (s.schoolYear) set.add(s.schoolYear); });
    return Array.from(set).sort();
  }

  // Populate any <select> element with the available school year options.
  // The selected value is preserved across re-populations when possible.
  function populateSchoolYearSelect(selectEl, options) {
    options = options || {};
    const previousValue = selectEl.value;
    const years = getSchoolYearList();
    U.clearNode(selectEl);
    if (options.includeAll) {
      selectEl.appendChild(U.el('option', { value: '__all' }, 'All school years'));
    }
    years.forEach(y => {
      const opt = U.el('option', { value: y }, y + (y === getActiveSchoolYear() ? ' (active)' : ''));
      selectEl.appendChild(opt);
    });
    // Restore previous selection if still valid; otherwise default.
    if (previousValue && Array.from(selectEl.options).some(o => o.value === previousValue)) {
      selectEl.value = previousValue;
    } else {
      selectEl.value = options.defaultValue || getActiveSchoolYear();
    }
  }

  // -------- School Year banner (top of misc fees view) --------
  function refreshSchoolYearBanner() {
    $('#sy-active-display').textContent = getActiveSchoolYear();
    populateSchoolYearSelect($('#sy-filter'), { includeAll: true, defaultValue: catalogYearFilter || getActiveSchoolYear() });
    if (catalogYearFilter === null || catalogYearFilter === getActiveSchoolYear()) {
      $('#sy-filter').value = getActiveSchoolYear();
    } else {
      $('#sy-filter').value = catalogYearFilter || '__all';
    }
    // The "Make this year active" button is meaningful only when the user
    // is viewing a non-active year (and not "All").
    const viewing = $('#sy-filter').value;
    const setActiveBtn = $('#sy-set-active');
    if (viewing && viewing !== '__all' && viewing !== getActiveSchoolYear()) {
      setActiveBtn.style.display = '';
    } else {
      setActiveBtn.style.display = 'none';
    }
  }

  function initSchoolYearBanner() {
    $('#sy-filter').addEventListener('change', e => {
      catalogYearFilter = e.target.value === '__all' ? '__all' : e.target.value;
      refreshSchoolYearBanner();
      renderMiscFeesList($('#mf-search').value);
    });
    $('#sy-set-active').addEventListener('click', () => {
      const target = $('#sy-filter').value;
      if (!target || target === '__all') return;
      if (target === getActiveSchoolYear()) return;
      if (!confirm(`Make ${target} the active school year?\n\nNew enrollments and auto-applied fees will use ${target} from now on.`)) return;
      setActiveSchoolYear(target);
      logActivity('cashier', 'settings.activeSchoolYear', target);
      U.toast(`Active school year is now ${target}`, 'success');
      refreshSchoolYearBanner();
      renderMiscFeesList($('#mf-search').value);
      // The form's school-year dropdown also needs refreshing.
      populateSchoolYearSelect($('#mf-school-year'));
    });
    $('#sy-new-year').addEventListener('click', openNewSYModal);

    // Wire the New Year modal
    $$('[data-close-sy]').forEach(b => b.addEventListener('click', closeNewSYModal));
    $('#sy-modal').addEventListener('click', e => {
      if (e.target.id === 'sy-modal') closeNewSYModal();
    });
    $('#sy-new-submit').addEventListener('click', () => {
      const val = $('#sy-new-input').value.trim();
      const makeActive = $('#sy-new-make-active').checked;
      if (!/^\d{4}-\d{4}$/.test(val)) return U.toast('Use the format YYYY-YYYY', 'error');
      // No-op if the year already exists; just switch the filter to it.
      if (makeActive) {
        setActiveSchoolYear(val);
        logActivity('cashier', 'settings.activeSchoolYear', val + ' (added)');
      } else {
        // Persist a placeholder so the year shows up in dropdowns even with
        // no fees yet. We store known years in Settings as an array.
        const known = window.HLC_STORAGE.Settings.get('knownSchoolYears', []);
        if (!known.includes(val)) {
          known.push(val);
          window.HLC_STORAGE.Settings.set('knownSchoolYears', known);
        }
      }
      catalogYearFilter = val;
      refreshSchoolYearBanner();
      populateSchoolYearSelect($('#mf-school-year'));
      renderMiscFeesList($('#mf-search').value);
      U.toast(`Added school year ${val}${makeActive ? ' and set as active' : ''}`, 'success');
      closeNewSYModal();
    });
  }

  function openNewSYModal() {
    $('#sy-new-input').value = '';
    $('#sy-new-make-active').checked = false;
    $('#sy-modal').classList.add('open');
  }
  function closeNewSYModal() {
    $('#sy-modal').classList.remove('open');
  }

  // -------- Misc Fee form (Add or Edit) --------
  // The form serves both Add and Edit. When `#mf-edit-id` is non-empty, the
  // form is in edit mode: submit calls editMiscFee() instead of MiscFees.create(),
  // the title and submit button are relabeled, and a "Cancel edit" button
  // appears. enterEditMode/exitEditMode toggle the chrome.
  function enterEditMode(fee) {
    $('#mf-edit-id').value = fee.id;
    $('#mf-name').value = fee.name;
    $('#mf-amount').value = fee.amount;
    $('#mf-category').value = fee.category;
    $('#mf-scope').value = fee.scope;
    $('#mf-school-year').value = fee.schoolYear || getActiveSchoolYear();
    $('#mf-desc').value = fee.description || '';
    // Sync grade chips
    $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => {
      cb.checked = (fee.gradeLevels || []).includes(cb.value);
    });
    // Show grade picker if applicable
    $('#mf-grades-field').style.display = fee.scope === 'grades' ? '' : 'none';
    // Update grade count label manually since we toggled checkboxes programmatically
    const n = (fee.gradeLevels || []).length;
    $('#mf-grades-count').textContent = n === 0 ? 'No grades selected' : `${n} grade${n === 1 ? '' : 's'} selected`;

    // Chrome
    $('#miscfee-form-title').textContent = `Edit Fee — ${fee.name}`;
    $('#miscfee-form-hint').textContent = 'Existing charges already on student accounts keep their original amount and won\'t be modified.';
    $('#mf-submit').textContent = 'Save Changes';
    $('#mf-cancel-edit').style.display = '';
    $('#miscfee-form-card').classList.add('editing');
    // Scroll the form into view
    $('#miscfee-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exitEditMode() {
    $('#mf-edit-id').value = '';
    $('#miscfee-form').reset();
    $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    $('#mf-grades-field').style.display = 'none';
    $('#mf-grades-count').textContent = 'No grades selected';
    $('#mf-school-year').value = getActiveSchoolYear();
    $('#miscfee-form-title').textContent = 'Add a Miscellaneous Fee';
    $('#miscfee-form-hint').textContent = 'Examples: Registration Fee (school-wide), Field Trip (optional), Late Payment Penalty (optional)';
    $('#mf-submit').textContent = 'Add Fee';
    $('#mf-cancel-edit').style.display = 'none';
    $('#miscfee-form-card').classList.remove('editing');
  }

  function initMiscFeeForm() {
    // Build the grade-level chip picker (one checkbox-styled chip per grade).
    // We use the canonical GRADE_LEVELS list from config so any future
    // additions (e.g. Junior/Senior Kinder) automatically appear here.
    const gradeChipsHost = $('#mf-grade-chips');
    const gradeLevels = (window.HLC_CONFIG && window.HLC_CONFIG.GRADE_LEVELS) || [];
    const gradesField = $('#mf-grades-field');
    const scopeSelect = $('#mf-scope');
    const countLabel  = $('#mf-grades-count');

    function renderGradeChips() {
      U.clearNode(gradeChipsHost);
      gradeLevels.forEach(g => {
        const chip = U.el('label', { class: 'grade-chip' }, [
          U.el('input', { type: 'checkbox', value: g, name: 'mf-grade' }),
          U.el('span', {}, g)
        ]);
        gradeChipsHost.appendChild(chip);
      });
      // Re-bind change handler after rebuild
      $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updateGradeCount);
      });
      updateGradeCount();
    }

    function getSelectedGrades() {
      return $$('#mf-grade-chips input[type="checkbox"]:checked').map(cb => cb.value);
    }

    function updateGradeCount() {
      const n = getSelectedGrades().length;
      countLabel.textContent = n === 0
        ? 'No grades selected'
        : `${n} grade${n === 1 ? '' : 's'} selected`;
    }

    function syncScopeVisibility() {
      const isGradeScope = scopeSelect.value === 'grades';
      gradesField.style.display = isGradeScope ? '' : 'none';
    }

    renderGradeChips();
    syncScopeVisibility();
    populateSchoolYearSelect($('#mf-school-year'));
    scopeSelect.addEventListener('change', syncScopeVisibility);

    // Bulk select / clear
    $('#mf-grades-all').addEventListener('click', () => {
      $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => { cb.checked = true; });
      updateGradeCount();
    });
    $('#mf-grades-none').addEventListener('click', () => {
      $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      updateGradeCount();
    });

    // Cancel edit
    $('#mf-cancel-edit').addEventListener('click', exitEditMode);

    // Reset button: also clear chips, re-sync visibility, and exit edit mode.
    $('#miscfee-form').addEventListener('reset', () => {
      // Defer so the native reset has finished clearing inputs first.
      setTimeout(() => {
        $$('#mf-grade-chips input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        syncScopeVisibility();
        updateGradeCount();
        $('#mf-school-year').value = getActiveSchoolYear();
      }, 0);
    });

    $('#miscfee-form').addEventListener('submit', e => {
      e.preventDefault();
      const editingId = $('#mf-edit-id').value;
      const name     = $('#mf-name').value.trim();
      const amount   = $('#mf-amount').value;
      const category = $('#mf-category').value;
      const scope    = scopeSelect.value;
      const desc     = $('#mf-desc').value.trim();
      const sy       = $('#mf-school-year').value || getActiveSchoolYear();
      const selectedGrades = scope === 'grades' ? getSelectedGrades() : [];

      if (!U.isNonEmpty(name))   return U.toast('Fee name is required', 'error');
      if (!Number.isFinite(Number(amount)) || Number(amount) < 0) return U.toast('Amount must be zero or positive', 'error');
      if (!category)             return U.toast('Pick a category', 'error');
      if (!scope)                return U.toast('Pick a scope', 'error');
      if (scope === 'grades' && selectedGrades.length === 0) {
        return U.toast('Pick at least one grade level for this fee', 'error');
      }

      // Audience-overlap-aware uniqueness check (see findNameConflict comment).
      // When editing, ignore the fee's own ID so a fee doesn't conflict with itself.
      const conflict = findNameConflict(name, scope, selectedGrades, sy, editingId || null);
      if (conflict) {
        return U.toast(buildConflictMessage(conflict, scope, selectedGrades), 'error');
      }

      // -------- EDIT path --------
      if (editingId) {
        const result = editMiscFee(editingId, {
          name,
          amount: Number(amount),
          category,
          scope,
          gradeLevels: selectedGrades,
          description: desc,
          schoolYear: sy
        });
        if (!result) return U.toast('Could not save changes', 'error');
        const retroN = result.retroAppliedToStudentIds.length;
        logActivity('cashier', 'miscfee.edit', `${name} · ${U.formatCurrency(amount)} · ${scope}${retroN ? ` · retro-applied to ${retroN} student(s)` : ''}`);
        U.toast(retroN
          ? `Saved "${name}" — newly applied to ${retroN} student(s)`
          : `Saved "${name}"`,
          'success');
        exitEditMode();
        renderMiscFeesList($('#mf-search').value);
        renderChargesTable();
        return;
      }

      // -------- ADD path --------
      const fee = {
        id: U.generateId('mf'),
        name,
        amount: Number(amount),
        category,
        scope,
        // gradeLevels is meaningful only when scope === 'grades'.
        // Stored as [] for other scopes so downstream code can read uniformly.
        gradeLevels: scope === 'grades' ? selectedGrades : [],
        autoApply: scope === 'school' || scope === 'grades',
        description: desc,
        schoolYear: sy,
        createdAt: new Date().toISOString()
      };
      MiscFees.create(fee);

      // Retro-apply auto-apply fees to existing students. For 'grades' scope
      // we only touch students whose gradeLevel is in the selected list AND
      // whose schoolYear matches; applySchoolWideFees() handles SY filtering
      // internally now, so skipping non-matching students here is purely an
      // optimization.
      let retroCount = 0;
      if (scope === 'school' || scope === 'grades') {
        const targetSet = scope === 'grades' ? new Set(selectedGrades) : null;
        Students.getAll().forEach(s => {
          if (targetSet && !targetSet.has(s.gradeLevel)) return;
          if ((s.schoolYear || getActiveSchoolYear()) !== sy) return;
          const applied = applySchoolWideFees(s.id);
          retroCount += applied.length;
        });
      }

      // Build a human-readable details string for the activity log
      const scopeLabel = scope === 'grades'
        ? `grades(${selectedGrades.join(', ')})`
        : scope;
      logActivity('cashier', 'miscfee.add', `${name} · ${U.formatCurrency(amount)} · ${scopeLabel} · ${sy}${retroCount ? ` · applied to ${retroCount} student(s)` : ''}`);

      let toastMsg;
      if (scope === 'school') {
        toastMsg = `Added "${name}" (${sy}) — applied to ${retroCount} existing student(s)`;
      } else if (scope === 'grades') {
        toastMsg = `Added "${name}" for ${selectedGrades.length} grade level(s) in ${sy} — applied to ${retroCount} existing student(s)`;
      } else {
        toastMsg = `Added optional fee: ${name} (${sy})`;
      }
      U.toast(toastMsg, 'success');
      e.target.reset();
      renderMiscFeesList($('#mf-search').value);
      renderChargesTable();
    });

    // Bulk-add launcher
    $('#miscfee-bulk-open').addEventListener('click', openBulkFeeModal);
  }

  // -------- Bulk Add Per-Grade Fees --------
  // The user types one fee name + category once and assigns a per-grade
  // amount to any subset of grades. Each row with a non-empty amount becomes
  // its own grade-targeted fee, so the same name (e.g. "Tuition") can sit
  // alongside fees for other grades — the audience-overlap rule allows this
  // when grade lists are disjoint.
  function openBulkFeeModal() {
    $('#bf-name').value = '';
    $('#bf-category').value = 'Registration';
    $('#bf-desc').value = '';
    populateSchoolYearSelect($('#bf-school-year'));

    const host = $('#bf-rows');
    U.clearNode(host);
    const gradeLevels = (window.HLC_CONFIG && window.HLC_CONFIG.GRADE_LEVELS) || [];
    gradeLevels.forEach(g => {
      const row = U.el('div', { class: 'bulkfee-row' }, [
        U.el('label', { class: 'bulkfee-row-label' }, [
          U.el('input', { type: 'checkbox', class: 'bulkfee-row-check', value: g, checked: '' }),
          U.el('span', {}, g)
        ]),
        U.el('input', {
          type: 'number',
          class: 'bulkfee-row-amount',
          'data-grade': g,
          min: '0',
          step: '0.01',
          placeholder: 'Amount'
        })
      ]);
      host.appendChild(row);
    });
    $('#bulkfee-modal').classList.add('open');
  }
  function closeBulkFeeModal() {
    $('#bulkfee-modal').classList.remove('open');
  }
  function initBulkFeeModal() {
    $$('[data-close-bulkfee]').forEach(b => b.addEventListener('click', closeBulkFeeModal));
    $('#bulkfee-modal').addEventListener('click', e => {
      if (e.target.id === 'bulkfee-modal') closeBulkFeeModal();
    });
    $('#bf-submit').addEventListener('click', () => {
      const name = $('#bf-name').value.trim();
      const category = $('#bf-category').value;
      const desc = $('#bf-desc').value.trim();
      const sy = $('#bf-school-year').value || getActiveSchoolYear();

      if (!name) return U.toast('Fee name is required', 'error');
      if (!category) return U.toast('Pick a category', 'error');

      // Gather rows: only checked rows with a non-empty positive amount.
      const rows = [];
      $$('.bulkfee-row').forEach(rowEl => {
        const cb = rowEl.querySelector('.bulkfee-row-check');
        const amtEl = rowEl.querySelector('.bulkfee-row-amount');
        if (!cb.checked) return;
        const amt = Number(amtEl.value);
        if (!Number.isFinite(amt) || amt <= 0) return;
        rows.push({ grade: cb.value, amount: amt });
      });

      if (!rows.length) return U.toast('Set an amount for at least one grade', 'error');

      // Pre-flight conflict check across all rows. Each row creates a
      // grade-targeted fee with [grade]. Bulk submission should fail entirely
      // if any one row would conflict — partial creation is worse than none.
      for (const row of rows) {
        const conflict = findNameConflict(name, 'grades', [row.grade], sy);
        if (conflict) {
          return U.toast(`Conflict: ${buildConflictMessage(conflict, 'grades', [row.grade])}`, 'error');
        }
      }

      // Create fees, retro-apply to existing matching students.
      let createdCount = 0;
      let retroTotal = 0;
      rows.forEach(row => {
        const fee = {
          id: U.generateId('mf'),
          name,
          amount: row.amount,
          category,
          scope: 'grades',
          gradeLevels: [row.grade],
          autoApply: true,
          description: desc,
          schoolYear: sy,
          createdAt: new Date().toISOString()
        };
        MiscFees.create(fee);
        createdCount++;
        Students.getAll().forEach(s => {
          if (s.gradeLevel !== row.grade) return;
          if ((s.schoolYear || getActiveSchoolYear()) !== sy) return;
          retroTotal += applySchoolWideFees(s.id).length;
        });
      });

      logActivity('cashier', 'miscfee.bulk',
        `${name} · ${createdCount} grade${createdCount === 1 ? '' : 's'} · ${sy}${retroTotal ? ` · applied to ${retroTotal} student(s)` : ''}`);
      U.toast(`Created ${createdCount} fee${createdCount === 1 ? '' : 's'} for "${name}"${retroTotal ? ` — applied to ${retroTotal} student(s)` : ''}`, 'success');
      closeBulkFeeModal();
      renderMiscFeesList($('#mf-search').value);
      renderChargesTable();
    });
  }

  // -------- Void Payment modal --------
  let pendingVoidPaymentId = null;
  function openVoidModal(paymentId) {
    const payment = Payments.getById(paymentId);
    if (!payment) return;
    if (payment.voidedAt) {
      return U.toast('Payment is already voided', 'info');
    }
    pendingVoidPaymentId = paymentId;
    const student = Students.getById(payment.studentId);
    $('#void-info').innerHTML = '';
    const info = U.el('div', { class: 'void-info-grid' }, [
      U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Receipt #'), U.el('span', { class: 'val' }, '#' + payment.id.slice(-8).toUpperCase())]),
      U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Student'), U.el('span', { class: 'val' }, student ? fullName(student) : '— Deleted —')]),
      U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Amount'), U.el('span', { class: 'val' }, U.formatCurrency(payment.amount))]),
      U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Method'), U.el('span', { class: 'val' }, payment.method)]),
      U.el('div', {}, [U.el('span', { class: 'lbl' }, 'Date'), U.el('span', { class: 'val' }, U.formatDateTime(payment.createdAt))])
    ]);
    $('#void-info').appendChild(info);
    $('#void-reason').value = '';
    $('#void-modal').classList.add('open');
  }
  function closeVoidModal() {
    $('#void-modal').classList.remove('open');
    pendingVoidPaymentId = null;
  }
  function initVoidPaymentModal() {
    $$('[data-close-void]').forEach(b => b.addEventListener('click', closeVoidModal));
    $('#void-modal').addEventListener('click', e => {
      if (e.target.id === 'void-modal') closeVoidModal();
    });
    $('#void-submit').addEventListener('click', () => {
      if (!pendingVoidPaymentId) return;
      const reason = $('#void-reason').value.trim();
      if (!reason) return U.toast('Reason is required', 'error');
      const result = voidPayment(pendingVoidPaymentId, { reason, voidedBy: me.fullName });
      if (!result) return U.toast('Could not void payment', 'error');
      const student = Students.getById(result.studentId);
      logActivity('cashier', 'payment.void', `#${result.id.slice(-8).toUpperCase()} · ${student ? fullName(student) : 'unknown'} · ${U.formatCurrency(result.amount)} · ${reason}`);
      U.toast('Payment voided', 'info');
      closeVoidModal();
      renderHistory($('#hist-search').value);
      renderDashboard();
    });
  }

  // Renders the fees catalog in three top-level sections — School-wide,
  // Grade-specific, Optional — and within Grade-specific, one collapsible
  // subgroup per grade level. A fee that targets multiple grades appears
  // once in each of its grade subgroups (with a "covers N grades" badge so
  // the user knows the underlying fee is shared). Each grade subgroup also
  // displays a per-student total (school-wide + grade-specific) so cashiers
  // can sanity-check what a new enrollee in that grade will be billed.
  function renderMiscFeesList(filter) {
    const host = $('#miscfees-list');
    U.clearNode(host);
    const all = MiscFees.getAll();
    const f = (filter || '').toLowerCase().trim();
    // Apply the school-year filter from the banner. Default: active SY.
    const yearFilter = catalogYearFilter || getActiveSchoolYear();

    // Search matches name, category, scope, and any of the assigned grade
    // levels — typing "grade 7" finds every fee that hits Grade 7.
    function matchesSearchFilter(fee) {
      if (!f) return true;
      return fee.name.toLowerCase().includes(f)
        || (fee.category || '').toLowerCase().includes(f)
        || (fee.scope || '').toLowerCase().includes(f)
        || (Array.isArray(fee.gradeLevels) && fee.gradeLevels.some(g => g.toLowerCase().includes(f)));
    }
    function matchesYearFilter(fee) {
      if (yearFilter === '__all') return true;
      const sy = fee.schoolYear || getActiveSchoolYear();
      return sy === yearFilter;
    }

    const matched = all.filter(fee => matchesSearchFilter(fee) && matchesYearFilter(fee));

    if (!all.length) {
      host.appendChild(emptyState(
        'No miscellaneous fees defined',
        'Use the form above to define your first miscellaneous fee.'
      ));
      return;
    }
    if (!matched.length) {
      const hint = yearFilter !== '__all'
        ? `No fees defined for ${yearFilter}. Use the form above, or switch the year filter.`
        : 'Try a different search term.';
      host.appendChild(emptyState('No matches', hint));
      return;
    }

    // Partition by scope.
    const schoolFees   = matched.filter(x => x.scope === 'school');
    const gradeFees    = matched.filter(x => x.scope === 'grades');
    const optionalFees = matched.filter(x => x.scope === 'optional');

    // Within scope, sort by category then name for stable display.
    const byCatName = (a, b) =>
      (a.category || '').localeCompare(b.category || '') ||
      a.name.localeCompare(b.name);
    schoolFees.sort(byCatName);
    optionalFees.sort(byCatName);

    // ----- School-wide section -----
    if (schoolFees.length) {
      const total = schoolFees.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      host.appendChild(buildScopeSection({
        cls: 'mf-section-school',
        title: 'School-Wide Fees',
        subtitle: `Auto-applied to every student · ${schoolFees.length} fee${schoolFees.length === 1 ? '' : 's'}`,
        totalLabel: 'Per-student subtotal',
        total: total,
        fees: schoolFees
      }));
    }

    // ----- Grade-specific section, with per-grade subgroups -----
    if (gradeFees.length) {
      // Build a map: gradeLevel -> [fees that cover it]. Preserve canonical
      // grade order from config (Kindergarten, Grade 1, ...) for stable display.
      const canonicalGrades = (window.HLC_CONFIG && window.HLC_CONFIG.GRADE_LEVELS) || [];
      const feesByGrade = new Map();
      gradeFees.forEach(fee => {
        (fee.gradeLevels || []).forEach(g => {
          if (!feesByGrade.has(g)) feesByGrade.set(g, []);
          feesByGrade.get(g).push(fee);
        });
      });

      // Order grades by canonical config order; any unknown grades go to the end alphabetically.
      const orderedGrades = [
        ...canonicalGrades.filter(g => feesByGrade.has(g)),
        ...[...feesByGrade.keys()].filter(g => !canonicalGrades.includes(g)).sort()
      ];

      // School-wide-fee total is added into each grade's total preview so the
      // user sees the *full* per-student bill for that grade.
      const allSchoolFees = MiscFees.getAll().filter(x => x.scope === 'school');
      const schoolTotal = allSchoolFees.reduce((s, x) => s + (Number(x.amount) || 0), 0);

      const wrapper = U.el('section', { class: 'mf-section mf-section-grades' });
      wrapper.appendChild(U.el('header', { class: 'mf-section-head' }, [
        U.el('div', {}, [
          U.el('h3', { class: 'mf-section-title' }, 'Grade-Specific Fees'),
          U.el('div', { class: 'mf-section-sub' },
            `Auto-applied based on enrollment grade · ${gradeFees.length} fee${gradeFees.length === 1 ? '' : 's'} across ${orderedGrades.length} grade${orderedGrades.length === 1 ? '' : 's'}`)
        ]),
        U.el('div', { class: 'mf-section-actions' }, [
          U.el('button', {
            type: 'button', class: 'btn btn-ghost btn-xs',
            onclick: () => $$('#miscfees-list .mf-grade-group').forEach(d => { d.open = true; })
          }, 'Expand all'),
          U.el('button', {
            type: 'button', class: 'btn btn-ghost btn-xs',
            onclick: () => $$('#miscfees-list .mf-grade-group').forEach(d => { d.open = false; })
          }, 'Collapse all')
        ])
      ]));

      orderedGrades.forEach(grade => {
        const feesForGrade = feesByGrade.get(grade).slice().sort(byCatName);
        const gradeSubtotal = feesForGrade.reduce((s, x) => s + (Number(x.amount) || 0), 0);
        const fullTotal = schoolTotal + gradeSubtotal;

        // <details> so the user can collapse/expand each grade.
        // Default: open, since the catalog being collapsed by default would
        // hide the very thing the page exists to show.
        const group = U.el('details', { class: 'mf-grade-group' });
        group.open = true;
        const summary = U.el('summary', { class: 'mf-grade-summary' }, [
          U.el('span', { class: 'mf-chev', 'aria-hidden': 'true' }, '▸'),
          U.el('span', { class: 'mf-grade-name' }, grade),
          U.el('span', { class: 'mf-grade-count' }, `${feesForGrade.length} fee${feesForGrade.length === 1 ? '' : 's'}`),
          U.el('span', { class: 'mf-grade-total' }, [
            U.el('span', { class: 'mf-grade-total-lbl' }, 'Per-student total'),
            U.el('span', { class: 'mf-grade-total-val' }, U.formatCurrency(fullTotal))
          ])
        ]);
        group.appendChild(summary);

        const cardGrid = U.el('div', { class: 'miscfee-grid mf-grade-grid' });
        feesForGrade.forEach(fee => {
          cardGrid.appendChild(buildFeeCard(fee, { contextGrade: grade }));
        });
        group.appendChild(cardGrid);
        wrapper.appendChild(group);
      });

      host.appendChild(wrapper);
    }

    // ----- Optional section -----
    if (optionalFees.length) {
      host.appendChild(buildScopeSection({
        cls: 'mf-section-optional',
        title: 'Optional Fees',
        subtitle: `Picked per student · ${optionalFees.length} fee${optionalFees.length === 1 ? '' : 's'}`,
        fees: optionalFees
      }));
    }
  }

  // Build a top-level scope section (used for School-wide and Optional —
  // both have a flat fee grid with no internal subgrouping).
  function buildScopeSection({ cls, title, subtitle, totalLabel, total, fees }) {
    const head = U.el('header', { class: 'mf-section-head' }, [
      U.el('div', {}, [
        U.el('h3', { class: 'mf-section-title' }, title),
        U.el('div', { class: 'mf-section-sub' }, subtitle)
      ]),
      total != null
        ? U.el('div', { class: 'mf-section-total' }, [
            U.el('span', { class: 'mf-grade-total-lbl' }, totalLabel || 'Total'),
            U.el('span', { class: 'mf-grade-total-val' }, U.formatCurrency(total))
          ])
        : null
    ].filter(Boolean));

    const grid = U.el('div', { class: 'miscfee-grid' });
    fees.forEach(fee => grid.appendChild(buildFeeCard(fee)));

    return U.el('section', { class: 'mf-section ' + cls }, [head, grid]);
  }

  // Build a single fee card. When rendered inside a per-grade subgroup
  // (contextGrade given), the card shows a small "+N other grades" badge
  // for fees that span multiple grades — this keeps the user aware that
  // removing this card affects multiple grade groups.
  function buildFeeCard(fee, options) {
    options = options || {};
    const scopeLabel =
      fee.scope === 'school'   ? 'School-wide' :
      fee.scope === 'grades'   ? 'Grade-level' :
                                 'Optional';

    // For grade-scoped fees: list of grades. When shown inside a grade
    // subgroup, show "Also: G2, G3" instead of the full list to reduce
    // visual repetition (the heading already tells you the current grade).
    let gradeChips = null;
    if (fee.scope === 'grades' && Array.isArray(fee.gradeLevels) && fee.gradeLevels.length) {
      const otherGrades = options.contextGrade
        ? fee.gradeLevels.filter(g => g !== options.contextGrade)
        : fee.gradeLevels;
      if (otherGrades.length) {
        const label = options.contextGrade ? 'Also covers' : 'Applies to';
        gradeChips = U.el('div', { class: 'miscfee-grade-list' }, [
          U.el('span', { class: 'miscfee-grade-list-lbl' }, label + ':'),
          ...otherGrades.map(g => U.el('span', { class: 'miscfee-grade-pill' }, g))
        ]);
      }
    }

    // When a card is rendered inside a per-grade subgroup but the underlying
    // fee covers multiple grades, the Remove confirmation needs to spell that
    // out. We pass the full grade list to deleteMiscFee for the warning.
    const multiGradeNote = (fee.scope === 'grades'
      && Array.isArray(fee.gradeLevels)
      && fee.gradeLevels.length > 1
      && options.contextGrade)
      ? U.el('div', { class: 'miscfee-multigrade-note' },
          `Shared across ${fee.gradeLevels.length} grade levels`)
      : null;

    return U.el('div', { class: 'miscfee-card scope-' + fee.scope }, [
      U.el('div', { class: 'head' }, [
        U.el('h4', {}, fee.name),
        U.el('span', { class: 'scope-pill ' + fee.scope }, scopeLabel)
      ]),
      U.el('div', { class: 'cat' }, fee.category),
      U.el('div', { class: 'amt' }, U.formatCurrency(fee.amount)),
      gradeChips,
      multiGradeNote,
      fee.description ? U.el('div', { class: 'desc' }, fee.description) : null,
      U.el('div', { class: 'actions' }, [
        fee.scope === 'optional'
          ? U.el('button', {
              class: 'btn btn-accent btn-sm',
              onclick: () => openApplyFeeModal(fee.id)
            }, 'Apply to student')
          : null,
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => enterEditMode(fee)
        }, 'Edit'),
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => deleteMiscFee(fee.id, fee.name, fee)
        }, 'Remove')
      ].filter(Boolean))
    ].filter(Boolean));
  }

  function deleteMiscFee(id, name, fee) {
    // For grade-scoped fees that span multiple grades, make the consequence
    // explicit — otherwise a user removing "Athletic Fee" from the Grade 7
    // group might not realize it also disappears from Grade 8/9/10.
    let prompt = `Remove "${name}" from the catalog?\n\nExisting charges already applied to students will remain unchanged.`;
    if (fee && fee.scope === 'grades' && Array.isArray(fee.gradeLevels) && fee.gradeLevels.length > 1) {
      prompt = `Remove "${name}" from the catalog?\n\nThis fee covers ${fee.gradeLevels.length} grade levels (${fee.gradeLevels.join(', ')}). Removing it removes the definition for all of them.\n\nExisting charges already applied to students will remain unchanged.`;
    }
    if (!confirm(prompt)) return;
    MiscFees.remove(id);
    logActivity('cashier', 'miscfee.remove', name);
    U.toast('Fee removed from catalog', 'info');
    renderMiscFeesList($('#mf-search').value);
  }

  // Apply Optional Fee modal
  let pendingApplyFeeId = null;

  function openApplyFeeModal(feeId) {
    const fee = MiscFees.getById(feeId);
    if (!fee) return;
    pendingApplyFeeId = feeId;

    $('#af-title').textContent = `Apply: ${fee.name}`;
    $('#af-info').textContent = `${U.formatCurrency(fee.amount)} · ${fee.category}${fee.description ? ' · ' + fee.description : ''}`;

    const sel = $('#af-student');
    U.clearNode(sel);
    sel.appendChild(U.el('option', { value: '' }, '— Select a student —'));
    Students.getAll()
      .slice()
      .sort((a, b) => fullName(a).localeCompare(fullName(b)))
      .forEach(s => {
        // Skip students who already have this fee applied
        const alreadyApplied = (s.charges || []).some(c => c.source === 'misc-fee' && c.miscFeeId === feeId);
        const label = `${fullName(s)} · ${s.gradeLevel}${alreadyApplied ? ' · already applied' : ''}`;
        const opt = U.el('option', { value: s.id }, label);
        if (alreadyApplied) opt.disabled = true;
        sel.appendChild(opt);
      });

    $('#applyfee-modal').classList.add('open');
  }

  function closeApplyFeeModal() {
    $('#applyfee-modal').classList.remove('open');
    pendingApplyFeeId = null;
  }

  function initApplyFeeModal() {
    $$('[data-close-applyfee]').forEach(b => b.addEventListener('click', closeApplyFeeModal));
    $('#applyfee-modal').addEventListener('click', e => {
      if (e.target.id === 'applyfee-modal') closeApplyFeeModal();
    });
    $('#af-submit').addEventListener('click', () => {
      const studentId = $('#af-student').value;
      if (!studentId) return U.toast('Select a student', 'error');
      if (!pendingApplyFeeId) return;
      const fee = applyMiscFee(studentId, pendingApplyFeeId);
      if (!fee) return U.toast('Fee already applied or could not be applied', 'error');
      const student = Students.getById(studentId);
      logActivity('cashier', 'miscfee.apply', `${fee.name} → ${fullName(student)}`);
      U.toast(`Applied "${fee.name}" to ${fullName(student)}`, 'success');
      closeApplyFeeModal();
      renderChargesTable();
    });
  }

  // ----------- Collapsible "All Charges" section -----------
  // The charges list can get long once a school year is in flight; the
  // toggle lets cashiers collapse it to focus on the Misc Fees catalog
  // below. State is remembered across reloads so the section stays where
  // the user left it.
  const CHARGES_COLLAPSE_KEY = 'hlc_cashier_charges_collapsed';

  function setChargesCollapsed(collapsed) {
    const btn = $('#charges-collapse-btn');
    const panel = $('#charges-collapsible');
    if (!btn || !panel) return;
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = collapsed ? 'Expand section' : 'Collapse section';
    const label = btn.querySelector('.label');
    if (label) label.textContent = collapsed ? 'Show' : 'Hide';
    if (collapsed) panel.setAttribute('hidden', '');
    else panel.removeAttribute('hidden');
    try { localStorage.setItem(CHARGES_COLLAPSE_KEY, collapsed ? '1' : '0'); }
    catch (_) { /* private mode etc — non-fatal */ }
  }

  function initChargesCollapse() {
    const btn = $('#charges-collapse-btn');
    if (!btn) return;
    let initial = false;
    try { initial = localStorage.getItem(CHARGES_COLLAPSE_KEY) === '1'; }
    catch (_) {}
    setChargesCollapsed(initial);
    btn.addEventListener('click', () => {
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      setChargesCollapsed(isExpanded); // expanded → collapse
    });
  }

  // ----------- Boot -----------
  function init() {
    $('#page-meta').textContent = U.formatDateTime(new Date().toISOString());
    $$('.nav-list button').forEach(btn => btn.addEventListener('click', () => setActiveView(btn.dataset.view)));
    $$('[data-close-modal]').forEach(b => b.addEventListener('click', () => $('#receipt-modal').classList.remove('open')));
    $('#receipt-modal').addEventListener('click', e => { if (e.target.id === 'receipt-modal') $('#receipt-modal').classList.remove('open'); });
    $('#dues-search').addEventListener('input', e => renderDues(e.target.value));
    $('#hist-search').addEventListener('input', e => renderHistory(e.target.value));
    $('#charges-search').addEventListener('input', e => renderChargesTable(e.target.value));
    $('#mf-search').addEventListener('input', e => renderMiscFeesList(e.target.value));

    initChargesCollapse();
    initCollect();
    initChargeForm();
    initMiscFeeForm();
    initApplyFeeModal();
    initSchoolYearBanner();
    initBulkFeeModal();
    initVoidPaymentModal();
    refreshSchoolYearBanner();
    renderDashboard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
