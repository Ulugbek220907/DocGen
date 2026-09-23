-- DocGen AI — database schema
-- The server applies this file automatically on every boot (see
-- ensureSchema() in server.js), so every statement here MUST be safe to
-- re-run: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded DO
-- blocks, and never a DROP of anything that holds data.

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

-- Google-only accounts have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

-- 'plan' is the source of truth for what a user can do right now; only a
-- verified payment webhook ever changes it (paddle/payme/click-webhook.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Password reset: a hash of the emailed token, never the token itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------

-- Paddle subscriptions (and a record of each Payme/Click Pro period).
-- user_id is nullable + SET NULL so deleting an account keeps the financial
-- record (legally required in most places) without keeping the person.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider                  TEXT NOT NULL, -- 'paddle' | 'payme' | 'click'
  provider_subscription_id  TEXT,
  provider_customer_id      TEXT,
  status                    TEXT NOT NULL,
  current_period_end        TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_sub ON subscriptions (provider, provider_subscription_id);

-- One row per checkout attempt for the Uzbekistan rails. Payme's and
-- Click's merchant protocols are order-based: the amount is fixed per
-- order, and an order can be paid exactly once.
CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider    TEXT NOT NULL,           -- 'payme' | 'click'
  plan        TEXT NOT NULL,           -- 'pro'
  amount_uzs  BIGINT NOT NULL,         -- whole som
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'cancelled'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);

-- Payme Merchant API transaction (state: 1 created, 2 performed,
-- -1 cancelled before perform, -2 cancelled after perform). id is Payme's.
CREATE TABLE IF NOT EXISTS payme_transactions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount        BIGINT NOT NULL, -- tiyin (1/100 UZS)
  state         SMALLINT NOT NULL,
  create_time   BIGINT NOT NULL,
  perform_time  BIGINT NOT NULL DEFAULT 0,
  cancel_time   BIGINT NOT NULL DEFAULT 0,
  reason        SMALLINT
);
ALTER TABLE payme_transactions ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id);
ALTER TABLE payme_transactions ADD COLUMN IF NOT EXISTS payme_time BIGINT;
CREATE INDEX IF NOT EXISTS idx_payme_tx_order ON payme_transactions (order_id);

-- Click Merchant API two-phase (Prepare/Complete) transaction.
CREATE TABLE IF NOT EXISTS click_transactions (
  click_trans_id     BIGINT PRIMARY KEY,
  merchant_trans_id  TEXT NOT NULL,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount             NUMERIC NOT NULL,
  status             TEXT NOT NULL, -- 'prepared' | 'confirmed' | 'cancelled'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE click_transactions ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id);

-- Older deployments created these user_id columns NOT NULL with a plain
-- (RESTRICT) foreign key, which makes account deletion impossible. Relax
-- them to nullable + ON DELETE SET NULL, idempotently.
DO $$
DECLARE
  t TEXT;
  c TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'payme_transactions', 'click_transactions'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id DROP NOT NULL', t);
    SELECT con.conname INTO c
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = t AND con.contype = 'f' AND con.confdeltype <> 'n'
       AND con.confrelid = 'users'::regclass;
    IF c IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL', t, t || '_user_id_fkey');
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Chats and documents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);

-- A generated document is a first-class object: it lives in the user's
-- library, can be edited by hand or by AI, and outlives the chat it came
-- from (deleting a chat keeps its documents).
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  format           TEXT NOT NULL, -- 'pdf' | 'docx' | 'xlsx'
  schema           JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                SERIAL PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL, -- 'user' | 'assistant'
  content           TEXT NOT NULL,
  attachment_names  TEXT[],
  file_info         JSONB,
  document_schema   JSONB, -- legacy: pre-documents-table messages
  document_format   TEXT,  -- legacy
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);

-- Reports of offensive or harmful AI output (required by Google Play's
-- AI-generated content policy). Snapshot the content so the report stays
-- reviewable even after the user deletes the chat or their account.
CREATE TABLE IF NOT EXISTS content_reports (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id       INTEGER,
  document_id      TEXT,
  reason           TEXT NOT NULL,
  content_snapshot TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
