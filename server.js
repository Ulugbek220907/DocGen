require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./auth-routes');
const aiRoutes = require('./ai-routes');
const billingRoutes = require('./billing-routes');
const paddleWebhook = require('./paddle-webhook');
const paymeWebhook = require('./payme-webhook');
const clickWebhook = require('./click-webhook');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error(
    '[server] JWT_SECRET is not set. Copy .env.example to .env and fill it in ' +
    '(or set it in your Render dashboard) before starting the server.'
  );
  process.exit(1);
}

app.use(cors());

// Payment webhooks are mounted BEFORE the app-wide express.json() below —
// paddle-webhook.js needs the raw, unparsed body to verify Paddle's HMAC
// signature, and each webhook router declares whatever body parser it
// actually needs, so none of them should also go through a second global
// json() pass.
app.use('/webhooks/paddle', paddleWebhook);
app.use('/webhooks/payme', paymeWebhook);
app.use('/webhooks/click', clickWebhook);

app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/generate', aiRoutes);
app.use('/api/billing', billingRoutes);

// The frontend (index.html, app.js, style.css, and the vendored libraries)
// is served straight from this same process — no separate hosting, no CORS.
app.use(express.static(path.join(__dirname, 'public')));

// Any non-API route falls back to index.html, so the app works if someone
// bookmarks or refreshes a deep link.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DocGen AI server running on http://localhost:${PORT}`);
});
