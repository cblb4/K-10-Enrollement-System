/**
 * utils.js
 * Pure, reusable helper functions used across all role modules.
 * No DOM-specific to any one module; no business logic.
 */
(function (global) {
  'use strict';

  const CFG = global.HLC_CONFIG;

  // ---------- ID generation ----------
  function generateId(prefix) {
    return (prefix || 'id') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Formatting ----------
  function formatCurrency(amount) {
    const n = Number(amount) || 0;
    return CFG.CURRENCY + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: '2-digit' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Validation ----------
  function isNonEmpty(value) {
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function isPositiveNumber(value) {
    const n = Number(value);
    return !isNaN(n) && n > 0;
  }

  // ---------- DOM helpers ----------
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children !== undefined) {
      if (Array.isArray(children)) {
        children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
      } else {
        node.textContent = children;
      }
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- Toast / notifications ----------
  function toast(message, type) {
    type = type || 'info';
    let host = document.getElementById('hlc-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'hlc-toast-host';
      host.style.cssText = 'position:fixed;top:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
      document.body.appendChild(host);
    }
    const colors = {
      success: { bg: '#0f5132', border: '#a3cfbb' },
      error:   { bg: '#842029', border: '#f1aeb5' },
      info:    { bg: '#5a1a1a', border: '#d4af37' }
    };
    const c = colors[type] || colors.info;
    const t = document.createElement('div');
    t.style.cssText = `
      background:${c.bg};color:#fff;padding:12px 18px;border-radius:6px;
      border-left:4px solid ${c.border};box-shadow:0 6px 20px rgba(0,0,0,0.25);
      font-family:'Inter',sans-serif;font-size:14px;min-width:240px;max-width:360px;
      pointer-events:auto;animation:hlcToastIn .25s ease-out;
    `;
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  // ---------- Aggregation helpers (used by analytics) ----------
  function sumCharges(student) {
    if (!student || !Array.isArray(student.charges)) return 0;
    return student.charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  }

  function sumPaidCharges(student) {
    if (!student || !Array.isArray(student.charges)) return 0;
    return student.charges
      .filter(c => c.status === 'paid')
      .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  }

  function sumUnpaidCharges(student) {
    return sumCharges(student) - sumPaidCharges(student);
  }

  function groupBy(arr, keyFn) {
    return arr.reduce((acc, item) => {
      const k = keyFn(item);
      (acc[k] = acc[k] || []).push(item);
      return acc;
    }, {});
  }

  // ---------- Public API ----------
  global.HLC_UTILS = {
    generateId,
    formatCurrency,
    formatDate,
    formatDateTime,
    isNonEmpty,
    isPositiveNumber,
    $, $$, el, clearNode,
    toast,
    sumCharges, sumPaidCharges, sumUnpaidCharges,
    groupBy
  };
})(window);
