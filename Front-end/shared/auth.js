/**
 * auth.js
 *
 * Authentication & session management — backend version.
 *
 * Replaces the old SHA-256-in-the-browser demo with real backend auth:
 *   - signup() / login()  → POST /api/auth/{signup,login}
 *   - JWT stored in localStorage (under 'hlc_token' via HLC_API)
 *   - Sanitized user record stored in localStorage (under
 *     HLC_CONFIG.STORAGE_KEYS.CURRENT_USER) for synchronous reads from
 *     getCurrentUser() / requireRole()
 *   - logout() clears both
 *
 * The public API shape (signup/login/logout/getCurrentUser/requireRole) is
 * preserved so the page-level auth.js script and every module's role
 * guard keeps working untouched.
 */
(function (global) {
  'use strict';

  const KEYS  = global.HLC_CONFIG.STORAGE_KEYS;
  const ROLES = global.HLC_CONFIG.ROLES;
  const API   = global.HLC_API;

  if (!API) {
    throw new Error('HLC_AUTH: api.js must load before auth.js');
  }

  function _saveSession(user, token) {
    API.setToken(token);
    try { localStorage.setItem(KEYS.CURRENT_USER, JSON.stringify(user)); }
    catch (_) { /* private mode — token is still in memory */ }
  }

  function _clearSession() {
    API.clearToken();
    try { localStorage.removeItem(KEYS.CURRENT_USER); } catch (_) {}
  }

  async function signup({ fullName, email, password, role }) {
    if (!fullName || !email || !password || !role) {
      throw new Error('All fields are required.');
    }
    if (!ROLES.includes(role)) {
      throw new Error('Invalid role selected.');
    }

    let resp;
    try {
      resp = await API.post('/api/auth/signup', {
        fullName: String(fullName).trim(),
        email:    String(email).trim().toLowerCase(),
        password: password,
        role:     role
      });
    } catch (err) {
      // Re-throw with the server's error message visible to the page.
      throw new Error(err.message || 'Sign-up failed.');
    }

    // Server returns { user, token }. We DON'T auto-save the session here —
    // the existing page logic does an explicit login() after signup. That
    // way both "signup" and "switch user" go through the same code path.
    return resp.user;
  }

  async function login({ email, password }) {
    let resp;
    try {
      resp = await API.post('/api/auth/login', {
        email:    String(email || '').trim().toLowerCase(),
        password: password || ''
      });
    } catch (err) {
      throw new Error(err.message || 'Sign-in failed.');
    }
    _saveSession(resp.user, resp.token);
    return resp.user;
  }

  function logout() {
    _clearSession();
  }

  function getCurrentUser() {
    try {
      const raw = localStorage.getItem(KEYS.CURRENT_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Validate the current session against the server.
   *
   * `getCurrentUser()` reads localStorage synchronously and trusts whatever
   * is there — fine for keeping pages snappy during a session, but unsafe
   * as a "should I auto-redirect to the role home?" gate. A user can be
   * deleted, or have their role changed, after their session was cached.
   *
   * This helper hits GET /api/auth/me (which the backend's requireAuth +
   * controller validate against the users table), refreshes the cached
   * user if the server still recognizes them, or returns null if the
   * session is no longer valid. On 401, api.js#bounceToAuth has already
   * cleared the token and the cached user, so the caller can simply show
   * the login form.
   *
   * Returns: the fresh user object on success, null otherwise. Never
   * throws for the expected "session is gone" case.
   */
  async function refreshSession() {
    if (!API.getToken()) {
      _clearSession();
      return null;
    }
    try {
      const resp = await API.get('/api/auth/me');
      if (resp && resp.user) {
        // Re-cache the fresh user — role/email may have changed.
        try { localStorage.setItem(KEYS.CURRENT_USER, JSON.stringify(resp.user)); }
        catch (_) {}
        return resp.user;
      }
      return null;
    } catch (err) {
      // 401 → token invalid OR user deleted. api.js has cleared the
      // session for us; just signal "no session" to the caller.
      if (err && err.status === 401) return null;
      // Network or 5xx — caller decides; we don't lie about session state.
      throw err;
    }
  }

  /**
   * Guard a module page. If no session OR role mismatch, redirect to auth.
   * Pass the relative path back up to the auth page (e.g. '../../auth.html').
   */
  function requireRole(expectedRole, authPath) {
    const user = getCurrentUser();
    if (!user) {
      window.location.replace(authPath);
      return null;
    }
    if (user.role !== expectedRole) {
      const home = global.HLC_CONFIG.ROLE_HOMES[user.role];
      const base = authPath.replace(/auth\.html$/, '');
      window.location.replace(base + home);
      return null;
    }
    return user;
  }

  global.HLC_AUTH = {
    signup,
    login,
    logout,
    getCurrentUser,
    refreshSession,
    requireRole
  };
})(window);
