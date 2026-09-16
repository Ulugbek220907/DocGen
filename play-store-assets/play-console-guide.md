# Play Console submission reference

Google's exact question wording shifts between Play Console versions — treat
this as the facts to map onto whatever's on screen, not a literal transcript.
Based on what DocGen AI actually does (see `public/privacy.html`, which is
the canonical source — update both together if the app's data practices
change).

## Store listing

- **App name:** DocGen AI
- **Short description (max 80 chars):** Generate PDF, Word & Excel documents from a conversation with AI.
- **Full description:** adapt the "Features" section of `README.md`.
- **App icon:** already baked into the build (`assets/icon.png`).
- **Feature graphic:** `play-store-assets/feature-graphic.png` (1024×500, no alpha — verified).
- **Phone screenshots:** `play-store-assets/screenshots/*.png` (1080×1920, real screenshots of the actual app — register screen, main chat, plan/usage settings, and the upgrade flow for both payment rails). Google requires at least 2; these 5 cover it.
- **Privacy policy URL:** `https://<your-deployed-domain>/privacy.html` (already live if you've deployed — it's `public/privacy.html`).
- **Category:** Productivity.
- **Contact email:** whatever you want publicly listed for support.

## Data safety form

**Does your app collect or share any required user data types?** Yes.

| Data type | Collected? | Shared? | Purpose | Notes |
|---|---|---|---|---|
| Name | Yes | No | Account management, app functionality | From registration |
| Email address | Yes | Yes (Paddle/Payme/Click, only if user subscribes) | Account management, app functionality | Needed by payment processors to process a subscription |
| Purchase history | Yes | No | App functionality | Plan/subscription status, not raw payment details |
| Photos/videos | Yes, ephemeral | Yes (OpenRouter/AI provider) | App functionality | Only if the user attaches an image; not stored server-side beyond the request |
| Files and docs | Yes | Yes (OpenRouter/AI provider) | App functionality | Chat messages and generated-document content, sent to the AI provider to fulfill the request and stored in the app's own database tied to the account |
| App activity (app interactions) | Yes | No | App functionality | Monthly document-generation count, for plan limits |
| Financial info (payment info, e.g. card number) | **No** | — | — | Card/payment details go directly to Paddle/Payme/Click — this app never receives or stores them |
| Device/other IDs, location, contacts, calendar, health, audio | No | — | — | Not collected |

**Is data encrypted in transit?** Yes (HTTPS end to end).

**Can users request data deletion?** Yes — delete individual conversations in-app any time, or email the contact address in the privacy policy for full account deletion.

**Data collection is required or can users opt out?** Name/email are required to create an account (core function of the app); everything else follows from using the app's actual features.

## Content rating questionnaire (IARC)

- Category: **Utility / Productivity / AI Tool** (not a game, not social media).
- Violence, sexual content, profanity, gambling: none intentionally included by the app itself.
- **User-generated content:** yes, technically — the AI's replies and generated documents are shaped by user prompts. There's no user-to-user communication or public posting (each account only ever sees its own conversations), so this is not a "social" or "chat with strangers" app.
- **Shares location:** No.
- **Unrestricted internet access:** the app itself only talks to its own backend; the backend, not the app, talks to OpenRouter/Paddle/Payme/Click. Answer based on what the *app binary* does, which is "talks to one first-party backend."
- **In-app purchases / subscriptions:** Yes — the Pro plan, sold via Paddle (worldwide) and Payme/Click (Uzbekistan), not via Google Play Billing. This means you should also review Google Play's policy on billing for digital subscriptions sold outside Play Billing (policy has changed over time by region/content type — check the current policy for whether external payment links are permitted for this app's category before submitting).

## Before you submit

- [ ] `OPENROUTER_API_KEY` set and generation actually works on the live deployment
- [ ] At least one payment provider (Paddle, or Payme/Click) has real credentials — an "Upgrade" button that visibly does nothing is a bad first impression, even if not a rejection reason by itself
- [ ] Privacy policy URL loads publicly (no login required) — `/privacy.html` already isn't behind auth
- [ ] Play Console developer account created ($25 one-time fee)
- [ ] Upload `android-build-output/DocGenAI-release.aab` (not the `.apk`) as the release artifact
