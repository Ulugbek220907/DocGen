# Play Console submission guide — DocGen AI

Facts to enter in Play Console, based on what the app actually does. The
canonical data-practices source is `public/privacy.html`; update both
together if anything changes.

## Before you start

- [ ] Render: `AI_API_KEY` (DeepSeek), `GOOGLE_CLIENT_IDS`, `PUBLIC_URL` set; DeepSeek balance topped up; generation works on the live site
- [ ] Google Cloud: OAuth consent screen published (or your testers added as test users), Web client + Android client (upload-key SHA-1) created — see README > Google sign-in
- [ ] Render Postgres upgraded from the free plan (free databases are deleted 30 days after creation)
- [ ] Play Console developer account ($25 one-time). New *personal* accounts must run a **closed test with at least 12 testers for 14 days** before they can apply for production access — start this early.

## App setup

- **App name:** DocGen AI · **Package:** `com.docgen.app` · **Default language:** English (add Uzbek/Russian listings if you like)
- **App or game:** App · **Free or paid:** Free
- **Category:** Productivity
- **Upload:** `app-release.aab` (versionCode 2, versionName 1.1.0). Keep **Play App Signing** on (default).
- **After the first upload:** Play Console → Test and release → App integrity → copy the **App signing key SHA-1** and add a second Android OAuth client with it in Google Cloud. Without this, Google sign-in fails in the Play-installed app (it works in the directly installed APK, which is signed with the upload key).

## Store listing

- **Short description (≤80):** Create PDF, Word and Excel documents by chatting with AI.
- **Full description:**

  > DocGen AI turns a short description into a finished document — invoices, CVs, business letters, reports, meeting minutes, budgets and more — as PDF, Word or Excel.
  >
  > • Describe what you need in English, Uzbek or Russian
  > • Edit everything in a clean document editor: tap any text, add sections, lists and tables, undo and redo
  > • Ask the AI to change the document: "add a row for transport", "make it more formal", "translate to Russian"
  > • Spreadsheets keep working formulas in Excel
  > • Every document is saved to your library — search, rename, duplicate
  > • Share or save files to Drive, Telegram, email or your phone
  > • One-tap sign-in with Google
  >
  > Free: 10 documents every 30 days.

- **Icon:** 512×512 from `assets/icon.png` (Play asks for it separately from the APK)
- **Feature graphic:** `play-store-assets/feature-graphic.png` (1024×500)
- **Phone screenshots:** `play-store-assets/screenshots/1-…6-*.png` (1080×1920, the actual Android UI)
- **Privacy policy URL:** `https://docgen-app-qpuo.onrender.com/privacy.html`

## App content

**Privacy policy:** URL above.

**Ads:** No ads.

**App access:** Sign-in is required. Give reviewers a working login: create an email/password account (the "Continue with email instead" link on the sign-in screen), e.g. `review@<your-domain>` with a strong password, and enter it under "All or some functionality is restricted" → add instructions: "Tap *Continue with email instead* and sign in with these credentials."

**Account deletion (required):**
- In-app: Menu → tap your name → Settings → Delete account
- Web URL for the form: `https://docgen-app-qpuo.onrender.com/delete-account.html`
- Data deleted: account, chats, documents. Data kept: payment records (no card data) for tax purposes.

**Target audience:** 18+ (simplest for an AI productivity app; avoids Families policy requirements).

**Content rating (IARC):** Reference/productivity tool. No violence, sexuality, profanity, drugs, gambling. Users can't communicate with each other and nothing is shared publicly. The app does not share location.

**Government app / Financial features / Health:** No.

**AI-generated content:** Yes — the app generates text with AI. Declare it where asked; it's a productivity tool, not a companion chatbot, and each account only sees its own content. Play's AI-Generated Content policy requires an in-app way to report offensive output: every AI reply has a flag button, and the document editor's ⋮ menu has "Report AI content". Reports are stored in the `content_reports` table (review them with `SELECT * FROM content_reports ORDER BY created_at DESC`).

## Data safety form

Data is encrypted in transit: **Yes**. Users can request deletion: **Yes** (in-app + web page). Data is not sold. No data used for ads or analytics.

| Data type | Collected | Shared | Purpose | Optional? |
|---|---|---|---|---|
| Name | Yes | No | Account management, app functionality | Required |
| Email address | Yes | No | Account management, app functionality | Required |
| User IDs (Google account ID) | Yes | No | Account management | Only with Google sign-in |
| Photos | Yes (processed, not stored) | Yes — sent to DeepSeek (AI provider) to fulfil the request | App functionality | Optional (only if attached) |
| Files and docs | Yes | Yes — sent to DeepSeek to fulfil the request | App functionality | Required for core feature |
| Other user-generated content (chat messages) | Yes | Yes — sent to DeepSeek | App functionality | Required for core feature |
| App interactions (monthly document count) | Yes | No | App functionality (plan limits) | Required |
| Purchase history (plan status) | Yes | No | App functionality | Only for Pro users |

Not collected: location, contacts, calendar, financial/payment info (card data goes only to the payment providers on the website), health, audio, device IDs, crash logs, diagnostics.

"Shared" note: Google treats sending data to a service provider that processes it on your behalf as *not* sharing. DeepSeek processes requests on the app's behalf, so you may answer "not shared" for those rows — answering "shared" is the conservative choice. Pick one and keep it consistent with the privacy policy.

## Payments and Play policy

Google Play requires **Google Play Billing** for digital subscriptions sold inside an app (Uzbekistan is not exempt). The Android build is therefore consumption-only:

- no prices, upgrade buttons or links to the website's checkout anywhere in the app
- users who bought Pro on the website see "Pro" and unlimited usage in the app (allowed — "consumption-only" / multi-platform access)
- in the Play Console monetisation questions, answer that the app has **no in-app purchases**

To sell Pro inside the Android app later, add Google Play Billing (a Play subscription product + server-side purchase verification) — the backend's plan model (`plans.grantProDays`) already supports another provider.
