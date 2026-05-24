/**
 * import-helpers.js
 *
 * Shared utilities for the Bulk Import flows in registrar.js (Students,
 * Subjects) and admin.js (Faculty). Provides:
 *
 *   - readSpreadsheetFile(file)  → async; reads .xlsx / .xls / .csv / .tsv
 *                                 and returns { headers, rows }.
 *   - parsePastedText(text)      → sync; the textarea-paste fallback.
 *   - applyAliasMap(row, alias)  → resolves messy spreadsheet headers
 *                                 ("First Name", "FNAME", "given_name") to
 *                                 canonical field names ("firstName").
 *   - toIsoDate(value)           → handles Excel serial dates, real Dates,
 *                                 and common string formats. Returns
 *                                 YYYY-MM-DD or '' if unparseable.
 *   - matchGradeLevel(value, options)
 *                                → forgiving grade matcher: "5", "G5",
 *                                 "Grade 5", "grade5" all match "Grade 5".
 *   - normalizeGender(value)     → "M"/"f"/"FEMALE" → "Male" / "Female".
 *   - downloadTemplate(name, headers, samples)
 *                                → builds and triggers download of an
 *                                 .xlsx template (or .csv if XLSX lib
 *                                 didn't load).
 *
 * Excel reading uses SheetJS (loaded from CDN by the host HTML page).
 * If that script didn't load — offline, blocked, etc. — readSpreadsheet-
 * File throws a clear error; everything else continues to work.
 */
(function (global) {
  'use strict';

  // ─── SheetJS detection ─────────────────────────────────────────────────
  function hasXLSXLib() {
    return typeof global.XLSX === 'object' && global.XLSX !== null
        && typeof global.XLSX.read === 'function';
  }

  // ─── Header normalization ──────────────────────────────────────────────
  // The whole point of the alias system: ignore case, spaces, underscores,
  // hyphens, slashes, dots, parens. "First Name" === "first_name" ===
  // "FIRSTNAME" === "first-name" === "first.name" → "firstname".
  function normalizeHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Resolve a raw row (header → value) into a canonical row (canonical
   * field → value) using an alias map of shape:
   *
   *   { canonicalField: ['alias1', 'alias2', ...], ... }
   *
   * Unmapped raw keys are dropped. String values are trimmed.
   */
  function applyAliasMap(rawRow, aliasMap) {
    // Build reverse lookup: normalized form → canonical field name.
    // The canonical field itself is also an alias for itself (so a header
    // already in canonical form just works).
    const lookup = Object.create(null);
    Object.keys(aliasMap).forEach(canonical => {
      lookup[normalizeHeader(canonical)] = canonical;
      (aliasMap[canonical] || []).forEach(alias => {
        lookup[normalizeHeader(alias)] = canonical;
      });
    });
    const out = Object.create(null);
    Object.keys(rawRow).forEach(rawKey => {
      const canonical = lookup[normalizeHeader(rawKey)];
      if (!canonical) return;
      const v = rawRow[rawKey];
      out[canonical] = (typeof v === 'string') ? v.trim() : v;
    });
    return out;
  }

  /**
   * Inspect which headers in `rawHeaders` matched a canonical field, and
   * which canonical fields had no match. Used to display the mapping in
   * the preview ("First Name → firstName", "missing: birthDate").
   */
  function diagnoseHeaderMapping(rawHeaders, aliasMap) {
    const lookup = Object.create(null);
    Object.keys(aliasMap).forEach(canonical => {
      lookup[normalizeHeader(canonical)] = canonical;
      (aliasMap[canonical] || []).forEach(alias => {
        lookup[normalizeHeader(alias)] = canonical;
      });
    });
    const mapped = [];         // [{ raw, canonical }]
    const unmapped = [];       // raw headers that matched no canonical field
    const seenCanonical = new Set();
    rawHeaders.forEach(raw => {
      if (!raw) return;
      const canonical = lookup[normalizeHeader(raw)];
      if (canonical) {
        mapped.push({ raw, canonical });
        seenCanonical.add(canonical);
      } else {
        unmapped.push(raw);
      }
    });
    const missingCanonical = Object.keys(aliasMap).filter(c => !seenCanonical.has(c));
    return { mapped, unmapped, missingCanonical };
  }

  // ─── Date handling ─────────────────────────────────────────────────────
  function pad2(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

  function formatIsoUTC(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /**
   * Convert whatever Excel / pasted text gave us into 'YYYY-MM-DD'.
   * Returns '' if we can't make sense of it. Handles:
   *   - JS Date objects (e.g. when SheetJS is configured with cellDates:true)
   *   - Excel serial numbers (days since 1899-12-30, accounting for the
   *     1900 leap-year bug Excel inherited from Lotus 1-2-3)
   *   - ISO-ish strings (YYYY-MM-DD, YYYY/MM/DD)
   *   - US-style and EU-style slash dates (M/D/YYYY and D/M/YYYY), with
   *     the "first half > 12" heuristic to pick the right one
   *   - Anything Date.parse can stomach as a last resort
   */
  function toIsoDate(value) {
    if (value === null || value === undefined || value === '') return '';
    if (value instanceof Date && !isNaN(value)) return formatIsoUTC(value);

    if (typeof value === 'number' && isFinite(value)) {
      // Excel's epoch is Dec 30 1899 (the off-by-two is intentional —
      // SheetJS docs explain the leap-year-bug compensation).
      const ms = Date.UTC(1899, 11, 30) + value * 86400000;
      const d = new Date(ms);
      if (!isNaN(d)) return formatIsoUTC(d);
      return '';
    }

    const s = String(value).trim();
    if (!s) return '';

    // ISO-ish: 2014-05-12 or 2014/5/12
    let m = s.match(/^(\d{4})[-/\.](\d{1,2})[-/\.](\d{1,2})/);
    if (m) {
      const y = +m[1], mo = +m[2], dy = +m[3];
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        return m[1] + '-' + pad2(mo) + '-' + pad2(dy);
      }
    }

    // Slash dates with 4-digit year at the end. Could be MM/DD/YYYY (US)
    // or DD/MM/YYYY (most everywhere else). Use the unambiguous case
    // (first part > 12) to pick D/M/Y; otherwise default to M/D/Y, which
    // is what Excel's English locale exports.
    m = s.match(/^(\d{1,2})[-/\.](\d{1,2})[-/\.](\d{4})/);
    if (m) {
      const a = +m[1], b = +m[2], y = m[3];
      if (a > 12 && b >= 1 && b <= 12) {
        return y + '-' + pad2(b) + '-' + pad2(a); // D/M/Y
      }
      if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
        return y + '-' + pad2(a) + '-' + pad2(b); // M/D/Y
      }
    }

    // Last resort: native parse.
    const d = new Date(s);
    if (!isNaN(d)) return formatIsoUTC(d);

    return '';
  }

  // ─── Other normalizers ─────────────────────────────────────────────────

  /**
   * Match a free-form grade string against the configured list. Tries:
   *   1. Exact case-insensitive match ("grade 5" → "Grade 5")
   *   2. Number-only ("5" → "Grade 5")
   *   3. "G5" / "g 5" → "Grade 5"
   *   4. Kinder variants:
   *        "early kinder" / "ek" / "k1"            → "Early Kinder"
   *        "junior kinder" / "jr kinder" / "k2"    → "Junior Kinder"
   *        "senior kinder" / "sr kinder" / "k3" /
   *        "k" / "kinder" / "kindergarten"          → "Senior Kinder"
   *        (Senior Kinder is the historical "Kindergarten" — used as
   *         the default so legacy imports keep matching the same cohort.)
   * Returns the canonical option from the list, or '' if no match.
   */
  function matchGradeLevel(value, options) {
    if (value === null || value === undefined) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const norm = raw.toLowerCase().replace(/\s+/g, '');

    for (let i = 0; i < options.length; i++) {
      if (options[i].toLowerCase().replace(/\s+/g, '') === norm) return options[i];
    }

    // Specific kinder variants first (most specific → least specific).
    function findOpt(re) { return options.find(o => re.test(o)); }
    if (/^(early|preprimary|prepkinder|pp|ek|k1)$/i.test(raw) ||
        /^earlykinder$/i.test(norm)) {
      const hit = findOpt(/early\s*kinder/i);
      if (hit) return hit;
    }
    if (/^(junior|jr|jrkinder|jr\.kinder|k2)$/i.test(raw) ||
        /^juniorkinder$/i.test(norm) ||
        /^jrkinder$/i.test(norm)) {
      const hit = findOpt(/junior\s*kinder/i);
      if (hit) return hit;
    }
    if (/^(senior|sr|srkinder|sr\.kinder|k3)$/i.test(raw) ||
        /^seniorkinder$/i.test(norm) ||
        /^srkinder$/i.test(norm)) {
      const hit = findOpt(/senior\s*kinder/i);
      if (hit) return hit;
    }

    // Generic kinder fallback — historical "Kindergarten" maps to Senior
    // Kinder so existing imports (which predate the split) keep landing
    // on the highest of the three levels.
    if (/^k(inder|indergarten)?$/i.test(raw)) {
      const senior = findOpt(/senior\s*kinder/i);
      if (senior) return senior;
      const anyKinder = findOpt(/kinder/i);
      if (anyKinder) return anyKinder;
    }

    const numMatch = raw.match(/^(?:grade|gr|g|year|yr|y)?\s*(\d{1,2})$/i);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      const target = 'grade' + n;
      const hit = options.find(o => o.toLowerCase().replace(/\s+/g, '') === target);
      if (hit) return hit;
    }

    return '';
  }

  /**
   * "M"/"m"/"male"/"MALE" → "Male". Same for female. Anything else passes
   * through unchanged so the validator can complain about it.
   */
  function normalizeGender(value) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (/^m(ale)?$/i.test(s))   return 'Male';
    if (/^f(emale)?$/i.test(s)) return 'Female';
    return s;
  }

  // ─── File reading ──────────────────────────────────────────────────────

  /**
   * Read any uploaded spreadsheet and return { headers, rows }. Rows are
   * plain objects keyed by the original header strings (NOT canonical
   * field names — that's the job of applyAliasMap).
   *
   *   .xlsx / .xls / .xlsm  → SheetJS
   *   .csv / .tsv / .txt    → text + HLC_CSV
   *
   * Throws if the file is an Excel file but SheetJS isn't loaded.
   */
  async function readSpreadsheetFile(file) {
    if (!file) throw new Error('No file selected.');
    const name = (file.name || '').toLowerCase();
    const isExcel = /\.(xlsx|xls|xlsm|xlsb|ods)$/.test(name);

    if (isExcel) {
      if (!hasXLSXLib()) {
        throw new Error(
          'Excel files need the spreadsheet library, which failed to load. ' +
          'Check your internet connection or paste your data into the box below.'
        );
      }
      const buf = await file.arrayBuffer();
      const wb = global.XLSX.read(buf, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('Excel file has no sheets.');
      const sheet = wb.Sheets[sheetName];
      // header:1 gives an array-of-arrays; raw:true keeps numbers/Dates
      // as their typed values so toIsoDate() can do its job.
      const aoa = global.XLSX.utils.sheet_to_json(sheet, {
        header: 1, raw: true, defval: ''
      });
      return aoaToRows(aoa);
    }

    // Plain text fallback (CSV/TSV/anything)
    const text = await file.text();
    if (!global.HLC_CSV || typeof global.HLC_CSV.parse !== 'function') {
      throw new Error('CSV parser unavailable (csv.js not loaded).');
    }
    return aoaToRows(global.HLC_CSV.parse(text));
  }

  /**
   * Convert an array-of-arrays (first row = headers) into { headers, rows }.
   * - Skips leading entirely-empty rows.
   * - Skips trailing entirely-empty rows.
   * - Drops cells that fall outside the header range.
   * - Trims header strings.
   */
  function aoaToRows(aoa) {
    if (!Array.isArray(aoa)) return { headers: [], rows: [] };

    // Strip leading rows that have no non-blank cells.
    let start = 0;
    while (start < aoa.length && isBlankRow(aoa[start])) start++;
    if (start >= aoa.length) return { headers: [], rows: [] };

    const headers = (aoa[start] || []).map(h => {
      if (h === null || h === undefined) return '';
      // Strip the UTF-8 BOM if it ended up on the first cell.
      return String(h).replace(/^\uFEFF/, '').trim();
    });
    if (!headers.some(h => h)) return { headers: [], rows: [] };

    const rows = [];
    for (let i = start + 1; i < aoa.length; i++) {
      const r = aoa[i];
      if (isBlankRow(r)) continue;
      const obj = Object.create(null);
      for (let j = 0; j < headers.length; j++) {
        const h = headers[j];
        if (!h) continue;
        const v = (r && r[j] !== undefined) ? r[j] : '';
        obj[h] = (v === null) ? '' : v;
      }
      rows.push(obj);
    }
    return { headers, rows };
  }

  function isBlankRow(r) {
    if (!Array.isArray(r)) return true;
    return r.every(c =>
      c === null || c === undefined ||
      (typeof c === 'string' && c.trim() === '')
    );
  }

  /**
   * Pasted-text path (the existing textarea workflow). Always synchronous.
   */
  function parsePastedText(text) {
    if (!text || !text.trim()) return { headers: [], rows: [] };
    if (!global.HLC_CSV || typeof global.HLC_CSV.parse !== 'function') {
      return { headers: [], rows: [] };
    }
    return aoaToRows(global.HLC_CSV.parse(text));
  }

  // ─── Template download ─────────────────────────────────────────────────

  /**
   * Generate and download a starter template file for users to fill in.
   * Prefers .xlsx (SheetJS); falls back to .csv if SheetJS isn't there.
   *
   *   filename     - 'students-template.xlsx' etc.
   *   headers      - ['firstName', 'lastName', ...]
   *   sampleRows   - [{ firstName: 'Maria', lastName: 'Cruz', ... }, ...]
   */
  function downloadTemplate(filename, headers, sampleRows) {
    sampleRows = sampleRows || [];

    if (hasXLSXLib()) {
      const aoa = [headers.slice()];
      sampleRows.forEach(r => {
        aoa.push(headers.map(h => r[h] === undefined ? '' : r[h]));
      });
      const ws = global.XLSX.utils.aoa_to_sheet(aoa);
      // Give the columns a sensible width so it doesn't open as a mess.
      ws['!cols'] = headers.map(h => ({ wch: Math.max(12, h.length + 2) }));
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, ws, 'Template');
      global.XLSX.writeFile(wb, filename);
      return;
    }

    // CSV fallback
    const csvName = filename.replace(/\.(xlsx|xls|xlsm)$/i, '.csv');
    const lines = [headers.map(csvEscape).join(',')];
    sampleRows.forEach(r => {
      lines.push(headers.map(h => csvEscape(r[h] == null ? '' : r[h])).join(','));
    });
    triggerBlobDownload(csvName, 'text/csv;charset=utf-8', '\uFEFF' + lines.join('\r\n'));
  }

  function csvEscape(v) {
    const s = String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function triggerBlobDownload(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // ─── Public API ────────────────────────────────────────────────────────
  global.HLC_IMPORT = {
    hasXLSXLib,
    normalizeHeader,
    applyAliasMap,
    diagnoseHeaderMapping,
    toIsoDate,
    matchGradeLevel,
    normalizeGender,
    readSpreadsheetFile,
    parsePastedText,
    downloadTemplate
  };
})(window);
