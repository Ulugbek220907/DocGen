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

// Render (and most managed Postgres providers) require SSL for any
// connection from outside their own network — including your own laptop
// talking to a Render database during local development. Rather than only
// enabling SSL when NODE_ENV=production (which is wrong for exactly that
// local-dev-against-a-cloud-db case), detect it from the host itself:
// localhost/127.0.0.1 never needs SSL, anything else almost always does.
function needsSSL(connectionString) {
  if (!connectionString) return false;
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    return host !== 'localhost' && host !== '127.0.0.1';
  } catch {
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false
});

module.exports = pool;