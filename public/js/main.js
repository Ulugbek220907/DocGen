// App entry point: boot (server wake-up, config, session restore), theme,
// Android integration, and wiring between the feature modules.
import './doc-schema.js';
import { api, getToken, setToken, clearToken, waitForServer, setUnauthorizedHandler } from './api.js';
import { state, persist, on } from './state.js';
import { hydrateIcons, toast, closeTopOverlay } from './ui.js';
import { initAuth, showAuth, signOut, consumeResetTokenFromUrl } from './auth.js';
import { initChat, newChat, openConversation, setGreeting, appendExternalExchange, resetChatState, friendlyQuotaMessage, onConversationRenamed } from './chat.js';
import { initDrawer, loadLists, renderAccount, clearLists, closeDrawer } from './drawer.js';
import { initStudio, openStudio, closeStudio, syncCards } from './studio.js';
import { initSettings, openSettings, openUpgrade, refreshBilling, pollForPro } from './settings.js';
import { preloadLibs } from './builders.js';
import { onBackButton, onResume, setSystemBarsTheme, hideSplash } from './native.js';

const $ = (id) => document.getElementById(id);
const systemLight = matchMedia('(prefers-color-scheme: light)');
let urlFlags = { resetToken: null, paymentReturn: false };
let booting = false;
let bootFailed = false;
let signingOut = false;

// ---------- theme ----------

function applyTheme(theme) {
  state.theme = theme;
  persist('theme', theme);
  const resolved = theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0f1115');
  setSystemBarsTheme(resolved === 'light');
}
systemLight.addEventListener('change', () => { if (state.theme === 'system') applyTheme('system'); });

// ---------- boot ----------

function setBoot(text, { failed = false } = {}) {
  $('bootStatus').textContent = text;
  $('bootSpinner').classList.toggle('hidden', failed);
  $('bootRetry').classList.toggle('hidden', !failed);
}

async function boot() {
  if (booting) return;
  booting = true;
  bootFailed = false;
  $('auth').classList.add('hidden');
  $('app').classList.add('hidden');
  $('boot').classList.remove('hidden');
  setBoot('Connecting…');
  try {
    await waitForServer(({ offline, elapsed }) => {
      if (offline) setBoot('You’re offline. Waiting for an internet connection…');
      else if (elapsed > 3500) setBoot('Waking up the server… this can take up to a minute after a quiet period.');
    });
    const cfg = await api('/api/config', { auth: false });
    state.config = { ...state.config, ...cfg };
  } catch (err) {
    bootFailed = true;
    setBoot(err.message, { failed: true });
    booting = false;
    return;
  }

  if (!getToken()) {
    booting = false;
    showAuth();
    return;
  }
  try {
    const data = await api('/api/auth/me');
    if (data.token) setToken(data.token);
    enterApp(data.user);
  } catch (err) {
    if (err.status === 401) {
      clearToken();
      showAuth({ message: err.code === 'account_deleted' ? 'This account no longer exists.' : 'Please sign in again.' });
    } else {
      bootFailed = true;
      setBoot(err.message, { failed: true });
    }
  } finally {
    booting = false;
  }
}

function enterApp(user, { created = false } = {}) {
  state.user = user;
  signingOut = false;
  $('boot').classList.add('hidden');
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderAccount();
  resetChatState();
  setGreeting();
  loadLists();
  refreshBilling().then(() => {
    if (urlFlags.paymentReturn) {
      urlFlags.paymentReturn = false;
      pollForPro();
    }
  });
  if (created) toast(`Welcome to DocGen, ${(user.name || '').split(/\s+/)[0] || 'friend'}!`, { type: 'success' });
  preloadLibs();
}

async function handleSignOut({ message } = {}) {
  if (signingOut) return;
  signingOut = true;
  closeStudio();
  while (closeTopOverlay()) { /* close every sheet/dialog */ }
  closeDrawer();
  await signOut();
  state.user = null;
  state.billing = null;
  state.conversations = [];
  state.documents = [];
  resetChatState();
  clearLists();
  showAuth({ message });
}

// ---------- wiring ----------

function init() {
  hydrateIcons();
  applyTheme(state.theme);
  hideSplash();
  urlFlags = consumeResetTokenFromUrl();

  initAuth((user, info) => enterApp(user, info));
  initChat({ openStudio, openUpgrade });
  initStudio({
    openConversation,
    openUpgrade,
    quotaMessage: friendlyQuotaMessage,
    onAiExchange: (conversationId, text, result) => {
      if (conversationId && !state.conversations.some(c => c.id === conversationId)) loadLists();
      appendExternalExchange(conversationId, text, result);
    }
  });
  initDrawer({ newChat, openConversation, openStudio, openSettings, onConversationRenamed });
  initSettings({ setTheme: applyTheme, onSignOut: handleSignOut });
  on('document-renamed', syncCards);

  setUnauthorizedHandler(err => {
    if (!state.user) return;
    handleSignOut({ message: err.code === 'account_deleted' ? 'This account no longer exists.' : 'Your session expired. Please sign in again.' });
  });

  $('bootRetry').addEventListener('click', boot);

  // Android back button: close whatever is on top (dialog, sheet, studio,
  // drawer); with nothing open, the app goes to the background.
  onBackButton(() => closeTopOverlay());
  onResume(() => { if (state.user) refreshBilling(); });

  window.addEventListener('offline', () => toast('You’re offline. Check your internet connection.', { type: 'error' }));
  window.addEventListener('online', () => {
    if (bootFailed) boot();
    else if (state.user) toast('Back online', { type: 'success', duration: 1800 });
  });
  // Escape closes the top overlay on desktop.
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTopOverlay(); });

  boot();
}

init();
