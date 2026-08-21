// Single shared Postgres connection pool, used by every route.
// DATABASE_URL comes from your .env locally, or from Render's environment
// variables in production (Render injects it automatically if you attach a
// Postgres instance to this service).
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL is not set. Copy .env.example to .env and fill it in ' +
    '(or set it in your Render dashboard) before starting the server.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL; local Postgres usually doesn't.
  // NODE_ENV=production (set automatically by Render) turns this on.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = pool;
