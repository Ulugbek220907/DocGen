// Applies schema.sql to whatever database
// DATABASE_URL points to. Run this once after deploying (or after pointing
// your local .env at a fresh database) with:
//
//   node init-db.js
//
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db-pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✓ Schema applied successfully.');
  } catch (err) {
    console.error('✗ Failed to apply schema:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
