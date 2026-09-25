// Where the backend lives. On the web the app is served by the backend
// itself, so relative URLs work. Inside the Android app the files are
// bundled in the APK (origin https://localhost), so API calls must go to the
// deployed server explicitly — change PRODUCTION_API if you redeploy.
export const PRODUCTION_API = 'https://docgen-app-qpuo.onrender.com';

const cap = window.Capacitor;
export const IS_NATIVE = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
export const PLATFORM = cap && typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'web';

export const API_BASE = IS_NATIVE ? PRODUCTION_API : '';

// Public pages (privacy policy, account deletion) always live on the server.
export const PUBLIC_BASE = IS_NATIVE ? PRODUCTION_API : window.location.origin;

export const APP_VERSION = '1.1.0';
