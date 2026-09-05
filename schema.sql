-- DocGen AI — database schema
-- Run this once against your Postgres database before starting the server.
-- Locally:  psql "$DATABASE_URL" -f schema.sql
-- On Render: use the "Connect" shell for your Postgres instance, or run this
-- from your local machine pointed at the Render DATABASE_URL.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

-- ---------------------------------------------------------------------------
-- Plans & billing
-- ---------------------------------------------------------------------------

-- 'plan' is the source of truth for what a user can do right now; a webhook
-- from whichever payment provider they used is the only thing that ever
-- changes it (see paddle-webhook.js / payme-webhook.js / click-webhook.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One row per subscription lifecycle we know about. Paddle subscriptions
-- live here; Payme/Click are one-off local charges tracked in their own
-- tables below (those providers don't have a native recurring-subscription
-- concept usable from a single Node backend without a licensed local
-- payment aggregator, so a Payme/Click "Pro" purchase buys a fixed period
-- and simply gets renewed by another charge — see billing-routes.js).
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id),
  provider                  TEXT NOT NULL, -- 'paddle' | 'payme' | 'click'
  provider_subscription_id  TEXT,
  provider_customer_id      TEXT,
  status                    TEXT NOT NULL, -- 'active' | 'canceled' | 'past_due'
  current_period_end        TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
-- Unique (not just indexed) so webhook upserts can ON CONFLICT (provider, provider_subscription_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_sub ON subscriptions (provider, provider_subscription_id);

-- Payme's Merchant API dictates these exact fields/semantics (state:
-- 1 = created, 2 = performed, -1 = cancelled after create, -2 = cancelled
-- after perform) — see https://developer.help.paycom.uz/en/. The row's id
-- is Payme's own transaction id, not ours.
CREATE TABLE IF NOT EXISTS payme_transactions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  amount        BIGINT NOT NULL, -- tiyin (1/100 UZS)
  state         SMALLINT NOT NULL,
  create_time   BIGINT NOT NULL,
  perform_time  BIGINT NOT NULL DEFAULT 0,
  cancel_time   BIGINT NOT NULL DEFAULT 0,
  reason        SMALLINT
);

-- Click's Merchant API two-phase (Prepare/Complete) protocol — see
-- https://docs.click.uz/en/click-api-request/
CREATE TABLE IF NOT EXISTS click_transactions (
  click_trans_id     BIGINT PRIMARY KEY,
  merchant_trans_id  TEXT NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  amount             NUMERIC NOT NULL,
  status             TEXT NOT NULL, -- 'prepared' | 'confirmed' | 'cancelled'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
