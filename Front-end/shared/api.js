/**
 * api.js
 *
 * Thin wrapper around fetch() for talking to the Heartworks backend.
 * Handles JWT injection, JSON encoding/decoding, error envelopes, and the
 * "token expired → bounce to login" redirect.
 *
 * Public API (window.HLC_API):
 *   setToken(t)       — persist the JWT
 *   getToken()        — read it back
 *   clearToken()      — log-out side
 *   request(method, path, body?)  — generic; returns the parsed JSON
 *   get/post/put/patch/del         — convenience shortcuts
 *
 * NOTE on token storage: keeping the JWT in localStorage is good enough for
 * an internal school tool. If you ever expose this to the open internet,
 * consider httpOnly cookies + CSRF tokens instead.
 */
(function (global) {
  'use strict';

  const CFG = global.HLC_CONFIG || {};
  // Where the API lives. Override in production by editing config.js.
  const BASE = (CFG.API_BASE || 'http://localhost:4000').replace(/\/+$/, '');
  const TOKEN_KEY = 'hlc_token';

  // ─── Token plumbing ────────────────────────────────────────────────────
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); }
    catch (_) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* private mode etc — ignore */ }
  }
  function clearToken() { setToken(null); }

  // ─── Auth-fail redirect ────────────────────────────────────────────────
  // When a request comes back 401 we assume the JWT is invalid/expired and
  // send the user back to auth.html. We figure out the relative path to
  // auth.html from where we currently are by counting modules/<role>/ depth.
  function authPath() {
    const here = global.location.pathname;
    if (/\/modules\/[^/]+\//.test(here)) return '../../auth.html';
    return 'auth.html';
  }
  function bounceToAuth() {
    clearToken();
    try { localStorage.removeItem(CFG.STORAGE_KEYS && CFG.STORAGE_KEYS.CURRENT_USER); } catch (_) {}
    // Avoid an infinite redirect loop if we're already on auth.
    if (!/auth\.html$/.test(global.location.pathname)) {
      global.location.replace(authPath());
    }
  }

  // ─── Core request ──────────────────────────────────────────────────────
  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : (BASE + path);
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (networkErr) {
      // Real network failure (server down, CORS preflight blocked, etc.)
      const e = new Error('Network error: ' + (networkErr && networkErr.message));
      e.isNetworkError = true;
      throw e;
    }

    // 204 No Content — nothing to parse.
    if (res.status === 204) return null;

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') !== -1) {
      try { data = await res.json(); } catch (_) { data = null; }
    } else {
      // non-JSON; keep raw text so the caller has *something* to display
      try { data = { error: await res.text() }; } catch (_) { data = null; }
    }

    if (!res.ok) {
      // Auth failure → bounce. Don't bounce on the auth endpoints
      // themselves, otherwise wrong-password feedback would never reach
      // the user.
      const isAuthCall = path.indexOf('/api/auth/login') === 0
                      || path.indexOf('/api/auth/signup') === 0;
      if (res.status === 401 && !isAuthCall) {
        bounceToAuth();
      }
      const msg = (data && data.error) || ('Request failed: ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.details = data && data.details;
      throw err;
    }
    return data;
  }

  // ─── Convenience verbs ─────────────────────────────────────────────────
  const get   = (path)        => request('GET',    path);
  const post  = (path, body)  => request('POST',   path, body || {});
  const put   = (path, body)  => request('PUT',    path, body || {});
  const patch = (path, body)  => request('PATCH',  path, body || {});
  const del   = (path)        => request('DELETE', path);

  global.HLC_API = {
    BASE,
    setToken, getToken, clearToken,
    request, get, post, put, patch, del
  };
})(window);
