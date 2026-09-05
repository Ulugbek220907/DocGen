# DocGen AI

Generate PDF, DOCX, and XLSX documents from plain-language descriptions, powered by a pooled AI key on the backend (defaults to Gemini 3.7 Flash via [OpenRouter](https://openrouter.ai)). Chat with the AI to draft the document, edit the result inline in the same conversation, and download the finished file.

Real accounts, hashed passwords, a real Postgres database, and real subscription billing (worldwide via Paddle, Uzbekistan via Payme/Click) — this is no longer a client-only prototype.

## Features

- **Real accounts** — registration and login are handled by a Node/Express backend with bcrypt-hashed passwords and signed session tokens, backed by Postgres
- **Free & Pro plans** — free accounts get a monthly document quota on a pooled AI key (no API key to paste in anymore); Pro is unlimited. See [Plans & billing](#plans--billing)
- **Chat-driven document generation** — describe what you need, the assistant asks clarifying questions when it needs more detail, and generates a real PDF/DOCX/XLSX when it has enough to work with
- **Inline document editor** — double-click any text or table cell directly in the chat to edit the generated document's actual content; changes regenerate the real file automatically
- **Rich formatting** — `**bold**`, `*italic*`, `` `code` ``, `^superscript`, `_subscript`, and real math notation, rendered properly across chat, PDF, and DOCX
- **Live Excel formulas** — table cells starting with `=` become real formulas (`=SUM(B2:B5)`) in generated spreadsheets, not frozen numbers
- **File attachments** — attach images (to vision-capable models) or text files and ask questions about them
- **Streaming responses** with live status updates
- **Session history synced to your account** — conversations and the document schema behind every generated file are stored in Postgres, tied to `user_id`, so they survive a cache clear and follow you across devices
- **Password reset via email** — "Forgot password?" on the login screen

## Project structure

Deliberately flat — no nested `routes/`/`middleware/`/`db/` folders for the server code, since those are easy to lose or misplace when assembling a repo by hand (this bit a real deploy: a `MODULE_NOT_FOUND` error on Render turned out to be a missing subfolder that never made it into the repo). The only subfolder is `public/`, which is required — everything in it is served as-is over HTTP, so keeping server code and `.env` out of it is a real security boundary, not just organization.

```
docgen-app/
├── server.js          # Express server — serves the API and the frontend
├── auth-routes.js      # /api/auth/register, /login, /me
├── require-auth.js     # JWT verification middleware
├── db-pool.js          # Postgres connection pool
├── plans.js             # Free/Pro plan definitions (limits, prices)
├── usage.js              # Monthly quota check-and-consume
├── ai-routes.js           # POST /api/generate/stream — pooled-key AI proxy, quota-gated
├── billing-routes.js       # GET /api/billing/status, POST /api/billing/checkout/*
├── paddle-webhook.js        # POST /webhooks/paddle — worldwide subscription events
├── payme-webhook.js          # POST /webhooks/payme — Uzbekistan (Payme Merchant API)
├── click-webhook.js           # POST /webhooks/click/{prepare,complete} — Uzbekistan (Click)
├── schema.sql                  # Run this once against your database
├── package.json
├── render.yaml                  # One-click Render deployment blueprint
├── capacitor.config.json         # Android app wrapper config
├── .env.example
└── public/                        # The frontend — served as static files
    ├── index.html
    ├── style.css
    ├── app.js
    └── pdfmake.min.js, vfs_fonts.js, docx.umd.js, exceljs.min.js
```

## Local setup

**1. Install dependencies**

```bash
npm install
```

**2. Set up Postgres.** Any Postgres instance works — a local install, a free Render Postgres, Supabase, or similar. You need a `DATABASE_URL` connection string either way.

Local Postgres example:
```bash
createdb docgen
psql docgen -f schema.sql
```

**3. Configure environment variables**

```bash
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — any long random string (generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `OPENROUTER_API_KEY` — one pooled key for every user, from [openrouter.ai/keys](https://openrouter.ai/keys) (see [Plans & billing](#plans--billing) — users no longer bring their own key)
- Payment provider variables, only needed once you're ready to accept real payments — see [Plans & billing](#plans--billing) below. The app runs fine without them; upgrade buttons just won't do anything yet.

**4. Run it**

```bash
npm start
```

Open `http://localhost:3000` and register an account (this creates a real row in your database, not `localStorage`). Free accounts get a monthly document quota on the pooled key set above; no per-user API key to configure anymore.

## Testing

```bash
npm test
```

Runs the real test suite (`tests/*.test.js`, Node's built-in test runner) against a real Postgres database — no mocks, same philosophy as the manual verification this project was built with. You need a throwaway database with the schema applied:

```bash
createdb docgen_test
psql docgen_test -f schema.sql
DATABASE_URL=postgresql://postgres@localhost:5432/docgen_test JWT_SECRET=any-string-for-tests npm test
```

Each test file starts its own instance of the server on an ephemeral port (`server.js` only binds a real port when run directly — `require('./server')` just gets you the Express app), so files run safely in parallel and never collide. Covers registration/login validation, the full password-reset lifecycle (including single-use and expiry), free/pro quota gating and the monthly rolling reset, request-id deduplication on the AI proxy, and conversation ownership isolation. Does **not** cover the Paddle/Payme/Click webhook protocol handlers end-to-end (those were verified manually during development — see the commit history) or anything requiring a real OpenRouter key.

## Plans & billing

- **Free** — a monthly document quota (`plans.js`) on the server's pooled OpenRouter key.
- **Pro** — unlimited, billed monthly. Two payment rails, both optional until configured:
  - **Worldwide** — [Paddle](https://paddle.com) as Merchant of Record (handles cards, VAT/tax, and payout — this sidesteps Stripe's country-restricted merchant onboarding, since Uzbekistan isn't a supported Stripe country). Set `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_ID`, `PADDLE_WEBHOOK_SECRET` and point a Paddle webhook destination at `/webhooks/paddle`.
  - **Uzbekistan** — [Payme](https://business.payme.uz) and [Click](https://merchant.click.uz), the two dominant local processors (needed because UzCard/Humo, most local cards, don't route through Paddle). Set `PAYME_MERCHANT_ID`/`PAYME_KEY` and `CLICK_SERVICE_ID`/`CLICK_MERCHANT_ID`/`CLICK_SECRET_KEY`; their dashboards need callback URLs `/webhooks/payme` and `/webhooks/click/{prepare,complete}` respectively.

All three require you to independently register a merchant account with that provider (identity/business verification) — see `.env.example` for exact variable names and where to find each one. Until real credentials are set, the "Upgrade" flow shows a friendly "not configured yet" message instead of erroring.

A user's plan is never set directly by the app — only a verified webhook from one of these three providers changes `users.plan`, so the source of truth always matches what was actually paid for.

## Deploying to Render

**Important — read this before pushing to GitHub:** make sure `public/` actually exists as a folder in your repo with all 7 files inside it. If you're adding files one at a time through GitHub's web UI, type the full path (e.g. `public/index.html`) into the "Name your file" box when creating each one — GitHub creates the folder automatically from that. If you drag-and-drop files instead, make sure you drag the whole `public` folder, not just its contents. A missing file here won't crash the server, but a missing `public/` folder will mean nothing loads when you visit the site.

1. Push this repo to GitHub — double-check on GitHub.com afterward that you see `server.js` and all the other root-level `.js` files listed in [Project structure](#project-structure) above, plus a `public/` folder containing all 7 frontend files
2. In the Render dashboard: **New → Blueprint**, connect the repo
3. Render provisions the web service and database, and auto-generates `JWT_SECRET` and `DATABASE_URL` for you
4. Once deployed, connect to the new database and run `schema.sql` against it once (Render's dashboard gives you a `psql` connection command under the database's "Connect" tab) — safe to re-run after future updates too, every statement in it is idempotent
5. Add `OPENROUTER_API_KEY` (required) and whichever payment provider variables from [Plans & billing](#plans--billing) you're ready to use (optional) in the service's Environment tab

**Free-tier caveats worth knowing before you rely on this:**
- Free web services spin down after 15 minutes of no traffic — the next request pays a ~1 minute cold start
- Free Postgres instances on Render expire after 30 days and are not automatically renewed — fine for testing, not for anything you don't want to lose
- Neither of these apply once you're on a paid plan

## Known limitations

- **Attachment content still isn't recoverable after reload.** Text/image file contents sent to the model aren't persisted (only filenames, for display) — same tradeoff as before, just now documented rather than accidental. Re-attach or use the "reuse" chip within the same page load.
- **Password reset emails need real SMTP credentials to actually send.** Without `SMTP_*` env vars set, the reset link is only printed to the server log — functional for local dev, not for real users. See `.env.example`.
- **Payment providers are scaffolded, not activated.** Paddle/Payme/Click integration code is complete and tested against synthetic requests, but real payments only start flowing once you've registered merchant accounts with each provider and set their env vars — see [Plans & billing](#plans--billing).
- **Plan/pricing numbers are placeholders.** `plans.js` ships with example limits and prices (5 free docs/month, $9 or 49,000 UZS for Pro) — tune them for your actual business before launch.
- **No self-serve "manage/cancel subscription" UI.** Paddle has a hosted customer portal you can link to once you have a real account; Payme/Click don't have a recurring-subscription concept, so a Pro period bought through them simply expires unless renewed.

## Roadmap ideas

- Persist attachment content too (not just filenames), so re-opening a conversation doesn't lose what was attached
- Branded templates (logo, color scheme, font persisted per user, applied to every generated document)
- Shareable read-only links for generated documents
- Self-serve subscription management (Paddle customer portal link, Payme/Click renewal reminders)
- iOS build alongside the Android one (see [Android app](#android-app))

## Android app

`android/` is a [Capacitor](https://capacitorjs.com) wrapper — a thin native
shell that loads the deployed web app at the URL in `capacitor.config.json`
(`server.url`). It's not an offline bundle: this app needs the real
Node/Postgres backend running somewhere reachable, same as the website.

`capacitor.config.json`'s `server.url` currently points at the live deployment
(`https://docgen-app-qpuo.onrender.com`). If you ever redeploy to a new URL
(a different Render service, your own domain, etc.), update that one line
and rebuild:

```bash
npx cap sync android
cd android && ./gradlew assembleRelease bundleRelease
```

Outputs land in `android/app/build/outputs/apk/release/app-release.apk`
(sideload/testing) and `android/app/build/outputs/bundle/release/app-release.aab`
(**this is the file Play Console wants** — Google has required `.aab`, not
`.apk`, for new Play Store listings since 2021).

**Signing:** both are already signed with a real release keystore
(`docgen-upload` alias) delivered alongside this build — see the keystore
handoff for exactly where. Gradle picks it up automatically via
`android/keystore.properties` (gitignored — never commit it or the
`.keystore` file itself). **Back up both immediately and somewhere safe.**
Losing them means you can never ship an update to this app once it's live
on the Play Store under `com.docgen.app` — Google would treat any rebuild
with a different key as a different app.

**Play Console basics:** create an app, choose "production" (or "internal
testing" first, recommended), upload the `.aab`, fill in the store listing
(the icon/splash already baked in came from `assets/` at the repo root —
regenerate with `npx capacitor-assets generate --android` if you swap the
source art), and submit for review.

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
