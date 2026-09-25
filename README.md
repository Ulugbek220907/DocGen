# DocGen AI

Create PDF, Word and Excel documents by chatting. Describe what you need in any language — the AI writes it, you polish it in a real editor, and the app builds the file on your device.

Web app + Android app, one Node/Express + Postgres backend, AI by [DeepSeek](https://platform.deepseek.com) (any OpenAI-compatible API works).

## Features

- **One-tap sign-in with Google** (web and native Android), with email + password as a fallback and a full password-reset flow
- **Chat to create** — templates for invoices, CVs, budgets, letters, reports and minutes; live progress while the document is written; stop button; follow-up suggestions
- **Document studio** — a WYSIWYG "paper" editor: tap any text to edit, Enter/Backspace split and merge paragraphs and bullets, section menu (add paragraph/list/table, move, delete), table tools (add/remove rows and columns), undo/redo, autosave
- **AI edits** — "Ask AI to change something…" rewrites the open document in place (undoable)
- **Real files** — PDF, DOCX and XLSX built on-device; tables keep live formulas in Excel and show computed values in PDF/Word; switch format any time
- **Library** — every document is saved to your account, searchable by title and content; rename, duplicate, delete
- **Attachments** — images (auto-downscaled) and text files (CSV, TXT, MD, JSON…)
- **Plans** — Free (10 documents / 30 days) and Pro (unlimited), paid on the web via Paddle (worldwide) or Payme / Click (Uzbekistan)
- **Account deletion** in-app and via a public page, as Google Play requires
- **Themes** — system, light, dark, midnight

## Project structure

```
server.js              Express app: security headers, routes, static files, schema auto-migration
config.js              Every environment variable, in one place
schema.sql             Idempotent schema — applied automatically on every boot
db-pool.js             Postgres pool
require-auth.js        JWT middleware
rate-limit.js          In-memory rate limiter
auth-routes.js         /api/auth: google, register, login, me, account deletion, password reset
google-verify.js       Google ID-token verification
generate-routes.js     /api/generate: AI chat + document generation over server-sent events
ai.js                  Streaming OpenAI-compatible client (DeepSeek by default)
prompt.js              System prompt + model-output parsing
documents-routes.js    /api/documents: library CRUD, search, duplicate
conversations-routes.js /api/conversations: chat history
plans.js / usage.js    Plan limits and metering
billing-routes.js      /api/billing: status, checkout links
paddle-webhook.js      /webhooks/paddle
payme-webhook.js       /webhooks/payme  (Payme Merchant API)
click-webhook.js       /webhooks/click/{prepare,complete}
mailer.js              SMTP for password-reset emails
public/                The app (served as-is, and bundled into the Android APK)
  index.html, style.css, privacy.html, delete-account.html
  js/                  ES modules: main, auth, chat, studio, drawer, settings, api, native, ui,
                       builders (PDF/DOCX/XLSX), formula, doc-schema (shared with the server)
  vendor/              pdfmake, docx, exceljs, capacitor (loaded on demand)
android/               Capacitor 8 Android project (com.docgen.app)
tests/                 node:test suite
```

## Local setup

```bash
npm install
cp .env.example .env      # then fill it in (see below)
npm start                 # http://localhost:3000
```

Minimum `.env`: `DATABASE_URL` (any Postgres), `JWT_SECRET` (long random string), `AI_API_KEY` (DeepSeek key). The schema is created automatically on startup. Without `GOOGLE_CLIENT_IDS` the sign-in screen shows the email form only; without payment keys the upgrade sheet says payments are coming soon.

## Testing

```bash
createdb docgen_test
DATABASE_URL=postgresql://postgres@localhost:5432/docgen_test JWT_SECRET=test npm test
```

46 tests against a real Postgres database, with the AI model and Google token verification stubbed (fast, free, deterministic). Covers: registration/login validation and errors, rate limiting, session refresh, Google sign-in (create, re-login, safe linking of verified emails), password reset, account deletion (data removed, payment records kept unlinked), generation (replies free, documents counted, retries on bad model output, AI failures, quota and Pro/expired-Pro gating, history, attachments, format detection), the documents library (search, normalisation, duplicate, legacy import, ownership), conversations, the full Payme JSON-RPC flow incl. refunds, Click prepare/complete signatures, Paddle signature verification and webhooks, AI-content reports, language detection, and the formula engine.

## Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → create a project → **OAuth consent screen** (External; app name, support email, privacy policy URL `https://<your-domain>/privacy.html`; scopes: email, profile, openid).
2. **Credentials → Create OAuth client ID → Web application.** Authorized JavaScript origins: your web domain (e.g. `https://docgen-app-qpuo.onrender.com`) and `http://localhost:3000`. Put this client ID in `GOOGLE_CLIENT_IDS`.
3. **Create OAuth client ID → Android**, package `com.docgen.app`, SHA-1 of the upload key. After the first upload to Play Console, create a second Android client with the **App signing key** SHA-1 (Play Console → Test and release → App integrity).

The Android app uses the Web client ID too (Credential Manager needs it); the Android clients only authorise the signing keys.

## Plans & billing

- **Free** — 10 documents per rolling 30 days (`plans.js`). Chat replies and manual edits are free; AI generations and AI edits count.
- **Pro** — unlimited. $9/month via **Paddle** (Merchant of Record: cards, PayPal, Apple/Google Pay, handles VAT; works for Uzbek sellers, unlike Stripe), or 49,000 so'm per 30 days via **Payme** or **Click** (UzCard/Humo).

Payments are order-based: the app creates an order, the provider's signed callback confirms it, and only then is Pro granted (`plans.grantProDays`). Callback URLs: `/webhooks/paddle`, `/webhooks/payme` (account field `order_id`), `/webhooks/click/prepare` and `/webhooks/click/complete`.

**Google Play rule:** apps distributed on Play must use Google Play Billing for digital subscriptions. The Android app therefore never shows prices, upgrade buttons or payment links — it only shows the current plan (Pro bought on the website works in the app). Adding Play Billing is the next step if you want to sell inside the app.

## Deploying (Render)

`render.yaml` is a Blueprint: **New → Blueprint** on Render, then set the prompted variables (`AI_API_KEY`, `GOOGLE_CLIENT_IDS`, `PUBLIC_URL`, payment keys). The schema migrates itself on boot. Free-tier notes: the web service sleeps after 15 idle minutes (the app shows "Waking up the server…" and waits), and **free Postgres databases expire 30 days after creation** — upgrade the database before relying on it.

## Android app

The web app in `public/` is bundled into the APK (fast start, works on bad networks); API calls go to `PRODUCTION_API` in `public/js/config.js`. Native features: Google sign-in (Credential Manager), save/share files through the Android share sheet, open files in an installed viewer, hardware back button, edge-to-edge safe areas, splash screen.

```bash
npx cap sync android
cd android && ./gradlew assembleRelease bundleRelease
```

- `android/app/build/outputs/bundle/release/app-release.aab` — upload this to Play Console
- `android/app/build/outputs/apk/release/app-release.apk` — for installing directly on a phone

Signing uses `android/keystore.properties` + the upload keystore (both gitignored). **Back them up** — without the upload key you can't publish updates (Play App Signing lets Google reset an upload key, but it takes days). Bump `versionCode` in `android/app/build.gradle` for every upload. Play submission details: [`play-store-assets/play-console-guide.md`](play-store-assets/play-console-guide.md).

## License

MIT — see below (matches the `license` field in `package.json`).

```
MIT License

Copyright (c) 2026 Ulugbek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
