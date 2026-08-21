-- DocGen AI — database schema
-- Run this once against your Postgres database before starting the server.
-- Locally:  psql "$DATABASE_URL" -f db/schema.sql
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
