/**
 * csv.js
 * Minimal RFC-4180-friendly CSV parser. Handles quoted fields, commas,
 * tabs (auto-detect), \r\n / \n line endings, double-quote escaping,
 * and a stray UTF-8 BOM at the start of the file.
 *
 * Why no library: this whole project is dependency-free at the data layer;
 * one little parser keeps it that way.
 *
 * Public API (window.HLC_CSV):
 *   parse(text)              → string[][] (array of row arrays)
 *   parseWithHeaders(text)   → object[]   (each row keyed by header text)
 *
 * Note: parseWithHeaders preserves header text as-is (after trimming and
 * BOM removal). It does NOT normalize case or spacing — the import flow
 * uses HLC_IMPORT.applyAliasMap() for forgiving header matching.
 */
(function (global) {
  'use strict';

  /**
   * Pick the delimiter for `text`. We look at the first non-empty line and
   * prefer whichever of tab/comma appears first. Falls back to comma.
   */
  function detectDelimiter(text) {
    const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '');
    const tab = firstLine.indexOf('\t');
    const comma = firstLine.indexOf(',');
    if (tab !== -1 && (comma === -1 || tab < comma)) return '\t';
    return ',';
  }

  /**
   * Parse CSV/TSV text into an array of row arrays.
   */
  function parse(text) {
    if (!text) return [];
    // Drop a leading UTF-8 BOM if present (Excel adds this when saving CSV).
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (!text.trim()) return [];

    const delim = detectDelimiter(text);

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === delim) {
          row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
          // Commit row on \n; ignore lone \r (treat \r\n as one terminator).
          if (c === '\n') {
            row.push(field); field = '';
            rows.push(row); row = [];
          }
        } else {
          field += c;
        }
      }
    }
    // Flush the final field/row if the file didn't end with a newline.
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }

    // Drop fully-empty rows (e.g. blank lines between data).
    return rows.filter(r => r.some(v => v != null && String(v).trim() !== ''));
  }

  /**
   * Parse with header row → array of objects keyed by the original header
   * text (trimmed; BOM removed). Header text is preserved verbatim — the
   * import flow handles case/spacing/alias normalization separately.
   */
  function parseWithHeaders(text) {
    const rows = parse(text);
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => String(h || '').replace(/^\uFEFF/, '').trim());
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const v = row[i];
        obj[h] = (v == null ? '' : String(v)).trim();
      });
      return obj;
    });
  }

  global.HLC_CSV = { parse, parseWithHeaders };
})(window);
