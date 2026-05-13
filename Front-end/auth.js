/**
 * auth.js (page script)
 * Handles the unified Sign In / Sign Up page.
 */
(function () {
  'use strict';

  const CFG = window.HLC_CONFIG;
  const AUTH = window.HLC_AUTH;
  const $ = window.HLC_UTILS.$;

  // ----- Render the logo placeholder (50% opacity) -----
  window.HLC_LOGO.renderLogo('#auth-logo');

  // ----- Populate role radios dynamically (no hardcoded list in HTML) -----
  // Done up-front so the form is fully built by the time the user sees it,
  // even if the session-validation round-trip below is mid-flight.
  const grid = $('#role-grid');
  CFG.ROLES.forEach((role, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="signup-role" value="${role}" ${idx === 0 ? 'checked' : ''} />
      <span>${CFG.ROLE_LABELS[role]}</span>
    `;
    grid.appendChild(label);
  });

  // ----- If already signed in, send to their home -----
  // The cached session in localStorage isn't enough on its own — the
  // account may have been deleted, or the role changed, since the cache
  // was written. Validate against the server before redirecting; if the
  // server rejects the session, fall through to the login form so the
  // user can re-authenticate (or sign up under a new account).
  const cached = AUTH.getCurrentUser();
  if (cached && CFG.ROLE_HOMES[cached.role]) {
    AUTH.refreshSession()
      .then(fresh => {
        if (fresh && CFG.ROLE_HOMES[fresh.role]) {
          window.location.replace(CFG.ROLE_HOMES[fresh.role]);
        }
        // else: stay on the page; the form is already built and visible.
      })
      .catch(() => {
        // Network or server error — let the user try to sign in normally.
      });
  }

  // ----- Tab switching -----
  const tabSignin = $('#tab-signin');
  const tabSignup = $('#tab-signup');
  const formSignin = $('#form-signin');
  const formSignup = $('#form-signup');
  const errBox = $('#auth-error');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('show');
  }
  function clearError() {
    errBox.textContent = '';
    errBox.classList.remove('show');
  }

  function activateTab(which) {
    clearError();
    if (which === 'signin') {
      tabSignin.classList.add('active');
      tabSignup.classList.remove('active');
      formSignin.style.display = 'flex';
      formSignup.style.display = 'none';
    } else {
      tabSignup.classList.add('active');
      tabSignin.classList.remove('active');
      formSignup.style.display = 'flex';
      formSignin.style.display = 'none';
    }
  }
  tabSignin.addEventListener('click', () => activateTab('signin'));
  tabSignup.addEventListener('click', () => activateTab('signup'));

  // ----- Sign In submit -----
  formSignin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    try {
      const user = await AUTH.login({
        email: $('#signin-email').value,
        password: $('#signin-password').value
      });
      window.HLC_STORAGE.logActivity(user.role, 'sign_in', user.email);
      window.location.replace(CFG.ROLE_HOMES[user.role]);
    } catch (err) {
      showError(err.message || 'Sign-in failed.');
    }
  });

  // ----- Sign Up submit -----
  formSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    try {
      const role = (document.querySelector('input[name="signup-role"]:checked') || {}).value;
      const user = await AUTH.signup({
        fullName: $('#signup-name').value,
        email: $('#signup-email').value,
        password: $('#signup-password').value,
        role
      });
      // Auto-login after signup
      await AUTH.login({
        email: $('#signup-email').value,
        password: $('#signup-password').value
      });
      window.HLC_STORAGE.logActivity(user.role, 'sign_up', user.email);
      window.location.replace(CFG.ROLE_HOMES[user.role]);
    } catch (err) {
      showError(err.message || 'Sign-up failed.');
    }
  });
})();
