require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const pool = require('./db-pool');
const { PLANS } = require('./plans');
const authRoutes = require('./auth-routes');
const generateRoutes = require('./generate-routes');
const documentsRoutes = require('./documents-routes');
const billingRoutes = require('./billing-routes');
const conversationsRoutes = require('./conversations-routes');
const reportsRoutes = require('./reports-routes');
const paddleWebhook = require('./paddle-webhook');
const paymeWebhook = require('./payme-webhook');
const clickWebhook = require('./click-webhook');

if (!process.env.JWT_SECRET) {
  console.error('[server] JWT_SECRET is not set. Copy .env.example to .env (or set it in Render) before starting.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) terminate TLS at a proxy; without this req.ip is
// the proxy's address, which breaks per-IP rate limiting.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Bearer tokens, not cookies, so any origin (the Android app's
// https://localhost included) can call the API safely.
app.use(cors({ maxAge: 86400 }));

// Payment webhooks parse their own bodies (Paddle needs the raw bytes for
// its signature), so they're mounted before the global JSON parser.
app.use('/webhooks/paddle', paddleWebhook);
app.use('/webhooks/payme', paymeWebhook);
app.use('/webhooks/click', clickWebhook);

// Generation requests can carry image attachments; everything else is small.
app.use('/api/generate', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Public, non-secret settings the app needs before sign-in.
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: config.google.clientIds[0] || null,
    vision: config.ai.vision,
    plans: {
      free: { monthlyDocs: PLANS.free.monthlyDocs },
      pro: { priceUsd: PLANS.pro.priceUsd, priceUzs: PLANS.pro.priceUzs, periodDays: PLANS.pro.periodDays }
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/reports', reportsRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Always revalidate the app shell so a deploy is picked up immediately.
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get(/^(?!\/api\/|\/webhooks\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Last-resort handler: log the real error, never leak it to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large.', code: 'too_large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request.', code: 'invalid_input' });
  }
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'server_error' });
});

// Applies schema.sql on every boot. Every statement in it is written to be
// safe to re-run, so a deploy never needs a separate manual migration step.
async function ensureSchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schemaSql);
    console.log('[server] Database schema is up to date.');
  } catch (err) {
    console.error('[server] Failed to apply schema.sql on startup:', err.message);
  }
}

// Only bind a port when run directly — the test suite does
// require('./server').listen(0) itself.
if (require.main === module) {
  ensureSchema().finally(() => {
    app.listen(PORT, () => {
      console.log(`DocGen AI server running on http://localhost:${PORT} (AI: ${config.ai.model} via ${config.ai.baseUrl}${config.ai.apiKey ? '' : ' — NO API KEY'})`);
    });
  });
}

module.exports = app;
module.exports.ensureSchema = ensureSchema;
