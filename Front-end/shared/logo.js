/**
 * logo.js
 * Renders the school logo placeholder.
 * To replace with the official logo later: drop your file at
 *   /assets/images/Logo.png  (or .svg)
 * and edit ONLY this file — set USE_PLACEHOLDER = false and the
 * src/path inside renderLogo().
 */
(function (global) {
  'use strict';

  const USE_PLACEHOLDER = false;

  // Where is this script loaded from? We use that to build the image URL.
  //
  // Why: the auth page lives at Front-end/auth.html, but the role modules
  // live two folders deeper at Front-end/modules/<role>/<name>.html.
  // A hardcoded relative path like "assets/images/Logo.png" works from
  // the auth page (resolves to Front-end/assets/...) but 404s from the
  // modules (resolves to Front-end/modules/<role>/assets/... which
  // doesn't exist).
  //
  // Since shared/logo.js itself is always at the same place
  // (Front-end/shared/logo.js), we can read its absolute URL from
  // document.currentScript at load time, strip the trailing
  // "shared/logo.js" to get the Front-end root, and build asset URLs
  // from there. Works for both file:// and http(s):// equally.
  const ASSET_BASE = (function () {
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src.replace(/shared\/logo\.js.*$/, '');
    }
    return '';
  })();
  const LOGO_URL = ASSET_BASE + 'assets/images/Logo.png';

  /**
   * SVG placeholder — open book + heart, in maroon and gold.
   * Sized via the container; opacity controlled by CSS class .logo-placeholder.
   */
  const PLACEHOLDER_SVG = `
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-label="Heartworks logo placeholder" role="img">
      <defs>
        <linearGradient id="hlcGold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e0c25a"/>
          <stop offset="100%" stop-color="#a8842a"/>
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r="56" fill="none" stroke="#3d0d11" stroke-width="2"/>
      <circle cx="60" cy="60" r="48" fill="none" stroke="url(#hlcGold)" stroke-width="1" stroke-dasharray="2 3"/>
      <!-- Open book -->
      <path d="M30 70 Q60 55 90 70 L90 88 Q60 75 30 88 Z" fill="#3d0d11"/>
      <line x1="60" y1="62" x2="60" y2="84" stroke="url(#hlcGold)" stroke-width="1.5"/>
      <!-- Heart above book -->
      <path d="M60 50 C 52 38, 38 42, 44 54 C 48 60, 60 66, 60 66 C 60 66, 72 60, 76 54 C 82 42, 68 38, 60 50 Z" fill="url(#hlcGold)"/>
      <!-- Wordmark arc text -->
      <text x="60" y="22" text-anchor="middle" font-family="Georgia, serif" font-size="8" fill="#3d0d11" letter-spacing="2">HEARTWORKS</text>
      <text x="60" y="106" text-anchor="middle" font-family="Georgia, serif" font-size="6" fill="#3d0d11" letter-spacing="3">LEARNING CENTER</text>
    </svg>
  `;

  /**
   * Render the logo into the given container element.
   * @param {Element|string} target - element or selector
   * @param {object} opts - { withOpacity: true|false }  default true
   */
  function renderLogo(target, opts) {
    const opt = Object.assign({ withOpacity: true }, opts || {});
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;

    if (USE_PLACEHOLDER) {
      el.innerHTML = PLACEHOLDER_SVG;
      el.classList.add('logo-mark');
      if (opt.withOpacity) el.classList.add('logo-placeholder');
    } else {
      // Real logo path — change LOGO_URL above when you have the official asset.
      el.innerHTML = '<img src="' + LOGO_URL + '" alt="Heartworks Learning Center" />';
      el.classList.add('logo-mark');
    }
  }

  global.HLC_LOGO = { renderLogo };
})(window);
