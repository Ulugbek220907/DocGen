const express = require('express');
const { Readable } = require('stream');
const requireAuth = require('./require-auth');
const { checkAndConsumeQuota } = require('./usage');

const router = express.Router();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Curated so a free/paid account can't point the pooled key at an arbitrary
// (possibly expensive) OpenRouter model. Configure via a comma-separated
// env var; the first entry is the default when the client asks for
// something outside this list.
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || 'google/gemini-3.7-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// One document generation "turn" in the client can involve up to three
// upstream OpenRouter calls (the initial request, a retry without
// response_format, a non-streaming fallback — see public/app.js
// callOpenRouter()). Those all share one X-Request-Id so we charge the
// user's quota once per turn, not once per retry. Single-process/single-
// instance deployment (see render.yaml), so in-memory is fine — this is
// the same MVP tradeoff already made for session storage (see README).
const recentRequests = new Map(); // `${userId}:${requestId}` -> { result, expiresAt }
const REQUEST_DEDUPE_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of recentRequests) {
    if (entry.expiresAt <= now) recentRequests.delete(key);
  }
}, 10 * 60 * 1000).unref();

async function getOrConsumeQuota(userId, requestId) {
  const key = `${userId}:${requestId}`;
  const cached = recentRequests.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await checkAndConsumeQuota(userId);
  recentRequests.set(key, { result, expiresAt: Date.now() + REQUEST_DEDUPE_MS });
  return result;
}

// Proxies chat completions to OpenRouter using our own pooled key, gated by
// the caller's plan/quota — the browser never sees an OpenRouter key.
// Forwards the request body largely as-is (public/app.js already builds the
// right shape) and relays the upstream response (streamed or not) straight
// through, so the client's existing streaming/parsing logic keeps working
// unchanged apart from the URL it calls.
router.post('/stream', requireAuth, async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: { message: 'The server is not configured with a pooled AI key yet.' } });
  }

  const requestId = req.headers['x-request-id'];
  if (!requestId) {
    return res.status(400).json({ error: 'Missing X-Request-Id header.' });
  }

  let quota;
  try {
    quota = await getOrConsumeQuota(req.userId, requestId);
  } catch (err) {
    console.error('Quota check error:', err);
    return res.status(500).json({ error: 'Could not check your usage. Please try again.' });
  }

  if (!quota.allowed) {
    return res.status(402).json({
      error: {
        message: `You've used all ${quota.limit} documents on your ${quota.plan} plan this month.`,
        upgradeRequired: true,
        plan: quota.plan
      }
    });
  }

  const body = { ...(req.body || {}) };
  if (!ALLOWED_MODELS.includes(body.model)) {
    body.model = ALLOWED_MODELS[0];
  }

  let upstream;
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': body.stream ? 'text/event-stream' : 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': `${req.protocol}://${req.get('host')}`,
        'X-Title': 'DocGen AI'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('OpenRouter upstream error:', err);
    return res.status(502).json({ error: 'Could not reach the AI provider. Please try again.' });
  }

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);

  if (!upstream.body) {
    return res.end();
  }
  Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;
