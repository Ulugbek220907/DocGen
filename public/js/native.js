// Thin wrappers around Capacitor native plugins. Every function degrades
// gracefully on the web (or on an older APK that lacks a plugin), so callers
// never need to branch on platform themselves.
import { IS_NATIVE } from './config.js';

const Cap = window.Capacitor;
const plugins = {};

function plugin(name) {
  if (!IS_NATIVE || !Cap?.isPluginAvailable?.(name)) return null;
  if (!plugins[name]) plugins[name] = Cap.registerPlugin(name);
  return plugins[name];
}

export function hasNativeGoogle() {
  return !!plugin('SocialLogin');
}

let socialInitFor = null;
async function ensureSocialLogin(webClientId) {
  const SocialLogin = plugin('SocialLogin');
  if (!SocialLogin) throw new Error('Native Google sign-in is not available in this version of the app.');
  if (socialInitFor !== webClientId) {
    await SocialLogin.initialize({ google: { webClientId } });
    socialInitFor = webClientId;
  }
  return SocialLogin;
}

// Returns a Google ID token (or null if the user cancelled).
export async function nativeGoogleSignIn(webClientId) {
  const SocialLogin = await ensureSocialLogin(webClientId);
  try {
    const res = await SocialLogin.login({ provider: 'google', options: {} });
    return res?.result?.idToken || null;
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/cancel/i.test(msg)) return null;
    if (/no credential|no credentials available/i.test(msg)) {
      throw new Error('No Google account found on this phone. Add one in Android settings, or continue with email.');
    }
    if (/28444|developer console|10:|DEVELOPER_ERROR/i.test(msg)) {
      throw new Error('Google sign-in isn’t fully set up for this app build yet. Please continue with email for now.');
    }
    throw new Error('Google sign-in failed. Please try again.');
  }
}

export async function nativeGoogleSignOut() {
  const SocialLogin = plugin('SocialLogin');
  if (!SocialLogin) return;
  try { await SocialLogin.logout({ provider: 'google' }); } catch { /* not signed in natively */ }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function writeCacheFile(blob, filename) {
  const Filesystem = plugin('Filesystem');
  if (!Filesystem) return null;
  const data = await blobToBase64(blob);
  const res = await Filesystem.writeFile({ path: `exports/${filename}`, data, directory: 'CACHE', recursive: true });
  return res.uri;
}

// Web: normal browser download. Android: blob downloads silently do nothing
// in a WebView, so write the file natively and open the share sheet (Save to
// Files/Drive, Telegram, email…).
export async function saveFile(blob, filename, mime) {
  if (IS_NATIVE) {
    const Share = plugin('Share');
    const uri = await writeCacheFile(blob, filename);
    if (uri && Share) {
      try {
        await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or share' });
      } catch (err) {
        if (!/cancel/i.test(String(err?.message || err))) throw err;
      }
      return 'shared';
    }
    throw new Error('Saving files isn’t supported in this version of the app. Please update it.');
  }
  const url = URL.createObjectURL(new Blob([blob], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// Opens the file in a viewer app (Android) or a new tab (web).
export async function openFile(blob, filename, mime) {
  if (IS_NATIVE) {
    const FileOpener = plugin('FileOpener');
    const uri = await writeCacheFile(blob, filename);
    if (FileOpener && uri) {
      try {
        await FileOpener.openFile({ path: uri, mimeType: mime });
        return;
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (/activity|no app|not found/i.test(msg)) {
          throw new Error(`No app on this phone can open ${filename.split('.').pop().toUpperCase()} files. Use Download to share it instead.`);
        }
        throw err;
      }
    }
    return saveFile(blob, filename, mime);
  }
  const url = URL.createObjectURL(new Blob([blob], { type: mime }));
  if (mime === 'application/pdf') {
    window.open(url, '_blank', 'noopener');
  } else {
    // Browsers can't display Word/Excel inline — fall back to download.
    await saveFile(blob, filename, mime);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function canOpenFiles() {
  return !IS_NATIVE || !!plugin('FileOpener');
}

// Hardware back button: handler returns true if it handled the press.
export function onBackButton(handler) {
  const App = plugin('App');
  if (!App) return;
  App.addListener('backButton', () => {
    if (!handler()) App.minimizeApp();
  });
}

export function onResume(handler) {
  const App = plugin('App');
  if (App) App.addListener('resume', handler);
  else document.addEventListener('visibilitychange', () => { if (!document.hidden) handler(); });
}

export async function openExternal(url) {
  const Browser = plugin('Browser');
  if (Browser) return Browser.open({ url });
  window.open(url, '_blank', 'noopener');
}

export async function setSystemBarsTheme(isLight) {
  const SystemBars = plugin('SystemBars');
  if (!SystemBars) return;
  try { await SystemBars.setStyle({ style: isLight ? 'LIGHT' : 'DARK' }); } catch { /* older Capacitor */ }
}

export async function hideSplash() {
  const SplashScreen = plugin('SplashScreen');
  if (SplashScreen) {
    try { await SplashScreen.hide({ fadeOutDuration: 200 }); } catch { /* already hidden */ }
  }
}
