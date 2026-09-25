// Sign-in screen. Google is the one-tap primary path; email/password stays
// available behind a link as a fallback (no Google account, or Google not
// configured yet), plus forgot/reset password.
import { api, setToken, clearToken, ApiError } from './api.js';
import { IS_NATIVE, PUBLIC_BASE } from './config.js';
import { state } from './state.js';
import { icon, setLoading, toast } from './ui.js';
import { hasNativeGoogle, nativeGoogleSignIn, nativeGoogleSignOut, openExternal } from './native.js';

const $ = (id) => document.getElementById(id);
let onSignedIn = () => {};
let emailMode = 'login';
let gisLoaded = null;
let resetToken = null;

export function consumeResetTokenFromUrl() {
  const params = new URLSearchParams(location.search);
  resetToken = params.get('resetToken');
  if (resetToken || params.has('payment')) {
    history.replaceState({}, '', location.pathname);
  }
  return { resetToken, paymentReturn: params.has('payment') };
}

export function initAuth(handler) {
  onSignedIn = handler;

  $('emailToggle').addEventListener('click', () => {
    $('emailForm').classList.remove('hidden');
    $('emailToggle').classList.add('hidden');
    $('emailForm').querySelector('input[name="email"]').focus();
  });

  $('emailForm').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => setEmailMode(btn.dataset.mode));
  });

  const pw = $('emailForm').querySelector('input[name="password"]');
  const toggle = $('pwToggle');
  toggle.innerHTML = icon('eye');
  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.innerHTML = icon(show ? 'eyeOff' : 'eye');
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  $('emailForm').addEventListener('submit', submitEmail);
  $('forgotLink').addEventListener('click', () => showPanel('forgot'));
  $('forgotForm').addEventListener('submit', submitForgot);
  $('resetForm').addEventListener('submit', submitReset);
  document.querySelectorAll('#auth [data-back]').forEach(b => b.addEventListener('click', () => showPanel('main')));
  $('googleNativeBtn').addEventListener('click', nativeGoogle);

  document.querySelectorAll('#auth [data-external]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); openExternal(PUBLIC_BASE + a.dataset.external); });
  });

  // Clear a field's error as soon as the user starts fixing it.
  document.querySelectorAll('#auth .input').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.closest('.field');
      field?.classList.remove('invalid');
      const err = field?.querySelector('.field-error');
      if (err) err.textContent = '';
    });
  });
}

export function showAuth({ message } = {}) {
  $('boot').classList.add('hidden');
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  showPanel(resetToken ? 'reset' : 'main');
  setupGoogle();
  if (message) toast(message, { type: 'info' });
}

function showPanel(name) {
  $('authMain').classList.toggle('hidden', name !== 'main');
  $('forgotForm').classList.toggle('hidden', name !== 'forgot');
  $('resetForm').classList.toggle('hidden', name !== 'reset');
  $('authTitle').textContent = name === 'forgot' ? 'Reset your password'
    : name === 'reset' ? 'Choose a new password'
    : 'Create documents by chatting';
  $('authSub').textContent = name === 'forgot' ? 'Enter your email and we’ll send you a reset link.'
    : name === 'reset' ? 'Your new password must be at least 8 characters.'
    : 'Invoices, CVs, reports and spreadsheets — ready as PDF, Word or Excel in seconds.';
  ['forgotForm', 'resetForm'].forEach(id => {
    const form = $(id);
    form.querySelector('.form-error').classList.add('hidden');
    form.querySelector('.form-info').classList.add('hidden');
  });
  if (name === 'forgot') {
    const email = $('emailForm').querySelector('input[name="email"]').value;
    $('forgotForm').querySelector('input[name="email"]').value = email;
  }
}

function setEmailMode(mode) {
  emailMode = mode;
  const form = $('emailForm');
  form.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  form.querySelector('[data-field="name"]').classList.toggle('hidden', mode !== 'register');
  form.querySelector('input[name="password"]').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('emailSubmit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
  $('forgotLink').classList.toggle('hidden', mode === 'register');
  clearErrors(form);
}

function clearErrors(form) {
  form.querySelectorAll('.field').forEach(f => { f.classList.remove('invalid'); const e = f.querySelector('.field-error'); if (e) e.textContent = ''; });
  const general = form.querySelector('.form-error');
  if (general) general.classList.add('hidden');
}

function showError(form, err) {
  const field = err instanceof ApiError && err.field ? form.querySelector(`[data-field="${err.field}"]`) : null;
  if (field) {
    field.classList.add('invalid');
    field.querySelector('.field-error').textContent = err.message;
    field.querySelector('input')?.focus();
  } else {
    const general = form.querySelector('.form-error');
    general.textContent = err.message || 'Something went wrong. Please try again.';
    general.classList.remove('hidden');
  }
}

function localValidate(form, values) {
  const errors = [];
  if (emailMode === 'register' && form === $('emailForm') && !values.name) errors.push(['name', 'Please enter your name.']);
  if (values.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push(['email', 'Please enter a valid email address.']);
  if (values.password !== undefined && values.password.length < 8) {
    errors.push(['password', emailMode === 'login' && form === $('emailForm') ? 'Please enter your password.' : 'Password must be at least 8 characters.']);
  }
  errors.forEach(([name, msg]) => {
    const f = form.querySelector(`[data-field="${name}"]`);
    f.classList.add('invalid');
    f.querySelector('.field-error').textContent = msg;
  });
  if (errors.length) form.querySelector(`[data-field="${errors[0][0]}"] input`).focus();
  return errors.length === 0;
}

async function submitEmail(e) {
  e.preventDefault();
  const form = $('emailForm');
  clearErrors(form);
  // form.name would be the <form>'s own name attribute, so use namedItem.
  const field = (n) => form.elements.namedItem(n).value;
  const values = {
    name: field('name').trim(),
    email: field('email').trim(),
    password: field('password')
  };
  if (!localValidate(form, emailMode === 'register' ? values : { email: values.email, password: values.password })) return;

  const btn = $('emailSubmit');
  setLoading(btn, true);
  try {
    const path = emailMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = emailMode === 'register' ? values : { email: values.email, password: values.password };
    const data = await api(path, { method: 'POST', body, auth: false });
    completeSignIn(data);
  } catch (err) {
    if (err.code === 'email_taken' && emailMode === 'register') {
      setEmailMode('login');
      form.elements.namedItem('email').value = values.email;
    }
    showError(form, err);
  } finally {
    setLoading(btn, false);
  }
}

async function submitForgot(e) {
  e.preventDefault();
  const form = $('forgotForm');
  clearErrors(form);
  const email = form.email.value.trim();
  if (!localValidate(form, { email })) return;
  const btn = form.querySelector('button[type="submit"]');
  setLoading(btn, true);
  try {
    const data = await api('/api/auth/forgot-password', { method: 'POST', body: { email }, auth: false });
    const info = form.querySelector('.form-info');
    info.textContent = data.message;
    info.classList.remove('hidden');
  } catch (err) {
    showError(form, err);
  } finally {
    setLoading(btn, false);
  }
}

async function submitReset(e) {
  e.preventDefault();
  const form = $('resetForm');
  clearErrors(form);
  const password = form.password.value;
  if (!localValidate(form, { password })) return;
  const btn = form.querySelector('button[type="submit"]');
  setLoading(btn, true);
  try {
    const data = await api('/api/auth/reset-password', { method: 'POST', body: { token: resetToken, password }, auth: false });
    resetToken = null;
    toast(data.message, { type: 'success' });
    showPanel('main');
    $('emailForm').classList.remove('hidden');
    $('emailToggle').classList.add('hidden');
    setEmailMode('login');
  } catch (err) {
    showError(form, err);
  } finally {
    setLoading(btn, false);
  }
}

function completeSignIn(data) {
  setToken(data.token);
  $('emailForm').reset();
  onSignedIn(data.user, { created: !!data.created });
}

async function exchangeGoogleToken(idToken) {
  const data = await api('/api/auth/google', { method: 'POST', body: { idToken }, auth: false });
  completeSignIn(data);
}

// ---------- Google ----------

function setupGoogle() {
  const clientId = state.config.googleClientId;
  const nativeBtn = $('googleNativeBtn');
  const webBtn = $('googleWebBtn');

  if (!clientId || (IS_NATIVE && !hasNativeGoogle())) {
    // Google isn't available here — show the email form straight away.
    $('googleArea').classList.add('hidden');
    $('emailToggle').classList.add('hidden');
    $('emailForm').classList.remove('hidden');
    return;
  }

  $('googleArea').classList.remove('hidden');
  if (IS_NATIVE) {
    nativeBtn.classList.remove('hidden');
    webBtn.classList.add('hidden');
  } else {
    nativeBtn.classList.add('hidden');
    webBtn.classList.remove('hidden');
    renderWebGoogleButton(clientId);
  }
}

async function nativeGoogle() {
  const btn = $('googleNativeBtn');
  setLoading(btn, true);
  try {
    const idToken = await nativeGoogleSignIn(state.config.googleClientId);
    if (!idToken) return; // user closed the account picker
    await exchangeGoogleToken(idToken);
  } catch (err) {
    toast(err.message, { type: 'error' });
    if (err.code === 'google_not_configured' || /continue with email/i.test(err.message)) {
      $('emailForm').classList.remove('hidden');
      $('emailToggle').classList.add('hidden');
    }
  } finally {
    setLoading(btn, false);
  }
}

function loadGis() {
  if (!gisLoaded) {
    gisLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisLoaded = null; reject(new Error('Could not load Google sign-in.')); };
      document.head.appendChild(s);
    });
  }
  return gisLoaded;
}

async function renderWebGoogleButton(clientId) {
  const host = $('googleWebBtn');
  try {
    await loadGis();
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response) => {
        try {
          await exchangeGoogleToken(response.credential);
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      },
      ux_mode: 'popup',
      auto_select: false,
      itp_support: true,
      use_fedcm_for_button: true
    });
    host.innerHTML = '';
    window.google.accounts.id.renderButton(host, {
      type: 'standard',
      theme: document.documentElement.dataset.theme === 'light' ? 'outline' : 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      logo_alignment: 'center',
      width: Math.min(380, host.clientWidth || 340)
    });
  } catch (err) {
    $('googleArea').classList.add('hidden');
    $('emailForm').classList.remove('hidden');
    $('emailToggle').classList.add('hidden');
  }
}

export async function signOut() {
  clearToken();
  await nativeGoogleSignOut();
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* not loaded */ }
}
