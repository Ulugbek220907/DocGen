// Settings sheet (account, plan & usage, theme, privacy, sign out, delete
// account) and the upgrade sheet with Paddle / Payme / Click.
//
// Google Play only allows Google Play Billing for digital subscriptions sold
// inside an Android app, so the Android build never shows prices, upgrade
// buttons or payment links — it only shows the current plan and usage.
import { api } from './api.js';
import { IS_NATIVE, PUBLIC_BASE, APP_VERSION } from './config.js';
import { state, on } from './state.js';
import { icon, escapeHtml, toast, openSheet, confirmDialog, promptDialog } from './ui.js';
import { openExternal } from './native.js';
import { renderAccount, renderPlanLabel } from './drawer.js';

let hooks = {};
let paddleReady = null;
let pollTimer = null;

export function initSettings(h) {
  hooks = h;
  on('usage-changed', (usage) => {
    if (!state.billing) return;
    Object.assign(state.billing, usage);
    renderPlanLabel();
  });
  on('usage-refresh', refreshBilling);
}

export async function refreshBilling() {
  try {
    state.billing = await api('/api/billing/status');
    renderPlanLabel();
  } catch { /* the label just stays as it was */ }
  return state.billing;
}

function fmtDate(d, opts = { day: 'numeric', month: 'long', year: 'numeric' }) {
  return new Date(d).toLocaleDateString(undefined, opts);
}

function planSectionHtml(b) {
  if (!b) return '<div class="muted">Couldn’t load your plan. Reopen settings to try again.</div>';
  if (b.plan === 'pro') {
    return `<div class="row"><span class="grow"><strong class="plan-pro">Pro</strong> — unlimited documents</span></div>
      ${b.planExpiresAt ? `<div class="muted" style="margin-top:6px">Active until ${fmtDate(b.planExpiresAt)}</div>` : ''}`;
  }
  const used = b.usageCount ?? 0;
  const pct = b.limit ? Math.min(100, Math.round((used / b.limit) * 100)) : 0;
  return `<div class="row"><span class="grow"><strong>Free plan</strong></span><span class="muted">${used} / ${b.limit} used</span></div>
    <div class="meter${b.remaining === 0 ? ' full' : ''}"><i style="width:${pct}%"></i></div>
    <div class="muted">${b.remaining === 0 ? 'You’ve used all your documents this month.' : `${b.remaining} documents left this month.`}
      ${b.resetsAt ? ` Resets on ${fmtDate(b.resetsAt, { day: 'numeric', month: 'long' })}.` : ''}</div>
    ${IS_NATIVE ? '' : `<button class="btn btn-primary btn-block" type="button" data-act="upgrade" style="margin-top:12px">${icon('crown')}Upgrade to Pro</button>`}`;
}

export async function openSettings() {
  const u = state.user;
  if (!u) return;
  const body = document.createElement('div');
  const theme = state.theme;
  body.innerHTML = `
    <div class="sheet-section">
      <div class="settings-account">
        <span class="avatar" id="setAvatar"></span>
        <div class="grow" style="min-width:0">
          <div class="acc-name" id="setName">${escapeHtml(u.name || '')}</div>
          <div class="muted" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.email)}</div>
          <div class="muted" style="font-size:12.5px">${u.googleLinked ? 'Signed in with Google' : 'Signed in with email'}</div>
        </div>
        <button class="icon-btn" type="button" data-act="rename" aria-label="Edit name">${icon('pencil')}</button>
      </div>
    </div>
    <div class="sheet-section">
      <div class="sheet-label">Plan</div>
      <div id="setPlan">${planSectionHtml(state.billing)}</div>
    </div>
    <div class="sheet-section">
      <div class="sheet-label">Appearance</div>
      <div class="seg seg-full theme-seg" role="radiogroup" aria-label="Theme">
        ${['system', 'light', 'dark', 'midnight'].map(t => `<button type="button" class="seg-btn${t === theme ? ' active' : ''}" data-theme-opt="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="sheet-section menu-list">
      <button class="menu-item" type="button" data-act="privacy">${icon('shield')}<span>Privacy policy</span></button>
      <button class="menu-item" type="button" data-act="signout">${icon('logout')}<span>Sign out</span></button>
      <button class="menu-item danger" type="button" data-act="delete">${icon('trash')}<span>Delete account</span></button>
    </div>
    <div class="version">DocGen AI ${escapeHtml(APP_VERSION)}</div>`;

  const sheet = openSheet({ title: 'Settings', body });
  const avatar = body.querySelector('#setAvatar');
  if (u.avatarUrl) avatar.style.backgroundImage = `url("${u.avatarUrl.replace(/"/g, '%22')}")`;
  else avatar.textContent = (u.name || u.email || '?').trim().charAt(0).toUpperCase();

  // Show fresh numbers without making the user wait for them.
  refreshBilling().then(b => {
    const el = body.querySelector('#setPlan');
    if (el && b) el.innerHTML = planSectionHtml(b);
  });

  body.addEventListener('click', async e => {
    const themeBtn = e.target.closest('[data-theme-opt]');
    if (themeBtn) {
      body.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('active', b === themeBtn));
      hooks.setTheme(themeBtn.dataset.themeOpt);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') {
      const name = await promptDialog({ title: 'Your name', value: state.user.name || '', maxLength: 120 });
      if (!name) return;
      try {
        const { user } = await api('/api/auth/me', { method: 'PATCH', body: { name } });
        state.user = user;
        body.querySelector('#setName').textContent = user.name;
        renderAccount();
      } catch (err) { toast(err.message, { type: 'error' }); }
    } else if (act === 'upgrade') {
      sheet.close();
      openUpgrade();
    } else if (act === 'privacy') {
      openExternal(`${PUBLIC_BASE}/privacy.html`);
    } else if (act === 'signout') {
      const ok = await confirmDialog({ title: 'Sign out?', message: 'Your chats and documents stay saved in your account.', confirmLabel: 'Sign out' });
      if (ok) { sheet.close(); hooks.onSignOut(); }
    } else if (act === 'delete') {
      deleteAccount(sheet);
    }
  });
}

async function deleteAccount(sheet) {
  const ok = await confirmDialog({
    title: 'Delete your account?',
    message: 'This permanently deletes your account, all chats and all documents. Active subscriptions are cancelled. This can’t be undone.',
    confirmLabel: 'Delete everything',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/auth/account', { method: 'DELETE', timeout: 45000 });
    sheet.close();
    hooks.onSignOut({ message: 'Your account and all its data were deleted.' });
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

// ---------- upgrade & payments (web only) ----------

export async function openUpgrade() {
  if (IS_NATIVE) return;
  const b = state.billing || await refreshBilling();
  const pricing = b?.pricing || state.config.plans?.pro || {};
  const pay = b?.payments || {};
  const usd = pricing.usd ?? pricing.priceUsd;
  const uzs = pricing.uzs ?? pricing.priceUzs;
  const anyMethod = pay.paddle || pay.payme || pay.click;

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="plan-card pro">
      <div class="row"><strong class="grow">DocGen Pro</strong>${icon('crown')}</div>
      <div class="plan-price">$${usd}<small> / month</small></div>
      ${uzs ? `<div class="muted">or ${Number(uzs).toLocaleString('ru-RU')} so‘m for 30 days in Uzbekistan</div>` : ''}
      <ul class="check-list">
        <li>Unlimited documents every month</li>
        <li>Unlimited AI edits of your documents</li>
        <li>PDF, Word and Excel exports</li>
        <li>Supports the development of DocGen</li>
      </ul>
    </div>
    ${b?.plan === 'pro' ? `<p class="muted">You already have Pro${b.planExpiresAt ? ` until ${fmtDate(b.planExpiresAt)}` : ''}. Paying again adds another period.</p>` : ''}
    <div class="pay-methods">
      ${pay.paddle ? `<button class="pay-btn" type="button" data-pay="paddle">
          <span class="pay-logo" style="background:#1a56db">${icon('globe')}</span>
          <span class="pay-text"><span class="pay-title">Card, PayPal, Apple / Google Pay</span><span class="pay-sub">Worldwide · $${usd}/month · renews monthly, cancel anytime</span></span></button>` : ''}
      ${pay.payme ? `<button class="pay-btn" type="button" data-pay="payme">
          <span class="pay-logo" style="background:#00a8a8">Payme</span>
          <span class="pay-text"><span class="pay-title">Payme</span><span class="pay-sub">UzCard, Humo, Visa · 30 days · no auto-renewal</span></span></button>` : ''}
      ${pay.click ? `<button class="pay-btn" type="button" data-pay="click">
          <span class="pay-logo" style="background:#0073ff">Click</span>
          <span class="pay-text"><span class="pay-title">Click</span><span class="pay-sub">UzCard, Humo · 30 days · no auto-renewal</span></span></button>` : ''}
      ${anyMethod ? '' : '<div class="form-info">Payments are being set up. Please check back soon.</div>'}
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:12px">Payments are processed securely by Paddle (worldwide) or Payme / Click (Uzbekistan). We never see your card details.</p>`;

  const sheet = openSheet({ title: 'Upgrade to Pro', body });
  body.addEventListener('click', e => {
    const btn = e.target.closest('[data-pay]');
    if (btn) startPayment(btn.dataset.pay, btn, sheet);
  });
}

function loadPaddle() {
  if (!paddleReady) {
    paddleReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload = resolve;
      s.onerror = () => { paddleReady = null; reject(new Error('Couldn’t load the payment window. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return paddleReady;
}

let paddleInitialized = false;
async function startPayment(provider, btn, sheet) {
  btn.classList.add('loading');
  try {
    if (provider === 'paddle') {
      const cfg = await api('/api/billing/checkout/paddle', { method: 'POST' });
      await loadPaddle();
      if (!paddleInitialized) {
        if (cfg.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({
          token: cfg.clientToken,
          eventCallback: (ev) => {
            if (ev?.name === 'checkout.completed') {
              toast('Payment received — activating Pro…', { type: 'success' });
              pollForPro();
            }
          }
        });
        paddleInitialized = true;
      }
      sheet.close();
      window.Paddle.Checkout.open({
        items: [{ priceId: cfg.priceId, quantity: 1 }],
        customer: { email: state.user.email },
        customData: cfg.customData,
        settings: { displayMode: 'overlay', theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', allowLogout: false }
      });
    } else {
      const { url } = await api(`/api/billing/checkout/${provider}`, { method: 'POST' });
      location.href = url;
    }
  } catch (err) {
    toast(err.message, { type: 'error' });
  } finally {
    btn.classList.remove('loading');
  }
}

// After a checkout, the plan changes when the provider's webhook arrives —
// usually within seconds. Poll briefly so the user sees it happen.
export function pollForPro() {
  clearInterval(pollTimer);
  const wasPro = state.billing?.plan === 'pro';
  const previousExpiry = state.billing?.planExpiresAt;
  let tries = 0;
  toast('Checking your payment…', { duration: 2500 });
  pollTimer = setInterval(async () => {
    tries++;
    const b = await refreshBilling();
    const upgraded = b && b.plan === 'pro' && (!wasPro || b.planExpiresAt !== previousExpiry);
    if (upgraded) {
      clearInterval(pollTimer);
      toast(`You’re on Pro${b.planExpiresAt ? ` until ${fmtDate(b.planExpiresAt)}` : ''}. Thank you!`, { type: 'success', duration: 6000 });
    } else if (tries >= 20) {
      clearInterval(pollTimer);
      toast('We haven’t received the payment confirmation yet. If you paid, it will appear within a few minutes.', { duration: 8000 });
    }
  }, 3000);
}

