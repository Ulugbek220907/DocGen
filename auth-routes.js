const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('./db-pool');
const config = require('./config');
const requireAuth = require('./require-auth');
const { sendMail } = require('./mailer');
const google = require('./google-verify');
const { createLimiter, byIp } = require('./rate-limit');

const router = express.Router();

const TOKEN_EXPIRY = '60d';
const REFRESH_AFTER_SECONDS = 24 * 60 * 60;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// Brute-force protection for anything that checks a secret.
const credentialLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: byIp,
  message: 'Too many attempts. Please wait a few minutes and try again.'
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signToken(userId) {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: TOKEN_EXPIRY });
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url || null,
    hasPassword: !!u.password_hash,
    googleLinked: !!u.google_sub
  };
}

async function touchLogin(userId) {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

function fail(res, status, code, error, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

router.post('/google', credentialLimiter, async (req, res) => {
  const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken : '';
  if (!idToken) return fail(res, 400, 'invalid_input', 'Missing Google credential.');

  let identity;
  try {
    identity = await google.verifyGoogleIdToken(idToken);
  } catch (err) {
    if (err.code === 'google_not_configured') return fail(res, 503, err.code, 'Google sign-in is not set up yet. Please use email for now.');
    if (err.code === 'google_no_email') return fail(res, 400, err.code, err.message);
    console.warn('[auth] Google token rejected:', err.message);
    return fail(res, 401, 'google_invalid', 'Google sign-in could not be verified. Please try again.');
  }

  // 1) Already linked to this Google account.
  let { rows } = await pool.query('SELECT * FROM users WHERE google_sub = $1', [identity.sub]);
  let user = rows[0];

  // 2) An existing email account with the same, Google-verified address:
  //    link it, so people who signed up with a password don't end up with
  //    two separate accounts.
  if (!user && identity.emailVerified) {
    ({ rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [identity.email]));
    if (rows[0]) {
      ({ rows } = await pool.query(
        'UPDATE users SET google_sub = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3 RETURNING *',
        [identity.sub, identity.picture, rows[0].id]
      ));
      user = rows[0];
    }
  }

  // 3) Brand new account.
  let created = false;
  if (!user) {
    try {
      ({ rows } = await pool.query(
        'INSERT INTO users (name, email, google_sub, avatar_url) VALUES ($1, $2, $3, $4) RETURNING *',
        [identity.name.slice(0, 120), identity.email, identity.sub, identity.picture]
      ));
      user = rows[0];
      created = true;
    } catch (err) {
      // The email exists but Google says it's unverified — don't hand over
      // someone else's account.
      if (err.code === '23505') return fail(res, 409, 'email_taken', 'An account with this email already exists. Sign in with your email and password.');
      throw err;
    }
  }

  await touchLogin(user.id);
  res.status(created ? 201 : 200).json({ token: signToken(user.id), user: publicUser(user), created });
});

// ---------------------------------------------------------------------------
// Email + password
// ---------------------------------------------------------------------------

router.post('/register', credentialLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'invalid_name', 'Please enter your name.', { field: 'name' });
  if (!email || !isValidEmail(String(email).trim())) return fail(res, 400, 'invalid_email', 'Please enter a valid email address.', { field: 'email' });
  if (!password || String(password).length < 8) return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.', { field: 'password' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await pool.query('SELECT id, password_hash FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (existing.rows[0]) {
    const msg = existing.rows[0].password_hash
      ? 'You already have an account with this email. Sign in instead.'
      : 'This email is registered with Google. Use “Continue with Google”.';
    return fail(res, 409, 'email_taken', msg, { field: 'email' });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password_hash, last_login_at) VALUES ($1, $2, $3, now()) RETURNING *',
    [String(name).trim().slice(0, 120), normalizedEmail, passwordHash]
  );
  res.status(201).json({ token: signToken(rows[0].id), user: publicUser(rows[0]) });
});

router.post('/login', credentialLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'invalid_input', 'Enter your email and password.');

  const normalizedEmail = String(email).trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
  const user = rows[0];

  if (user && !user.password_hash) {
    return fail(res, 400, 'use_google', 'This account signs in with Google. Use “Continue with Google”.');
  }
  // Same message for "no such user" and "wrong password".
  if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
    return fail(res, 401, 'invalid_credentials', 'That email and password don’t match. Check them and try again.');
  }

  await touchLogin(user.id);
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// Validates a stored token on app start. Hands back a fresh token once the
// current one is a day old, so active users effectively never get logged out.
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
  const user = rows[0];
  if (!user) return fail(res, 401, 'account_deleted', 'This account no longer exists.');
  const body = { user: publicUser(user) };
  if (!req.tokenIssuedAt || Date.now() / 1000 - req.tokenIssuedAt > REFRESH_AFTER_SECONDS) {
    body.token = signToken(user.id);
  }
  res.json(body);
});

router.patch('/me', requireAuth, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!name) return fail(res, 400, 'invalid_name', 'Name cannot be empty.');
  const { rows } = await pool.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name, req.userId]);
  res.json({ user: publicUser(rows[0]) });
});

// Required by Google Play for any app that lets people create accounts.
// Deletes the account and everything it owns (chats, messages, documents).
// Payment records are kept, unlinked, because tax law requires it.
router.delete('/account', requireAuth, async (req, res) => {
  const { rows: subs } = await pool.query(
    "SELECT provider_subscription_id FROM subscriptions WHERE user_id = $1 AND provider = 'paddle' AND status IN ('active', 'trialing', 'past_due')",
    [req.userId]
  );
  if (subs.length && config.paddle.apiKey) {
    const base = config.paddle.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    for (const s of subs) {
      try {
        const r = await fetch(`${base}/subscriptions/${s.provider_subscription_id}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.paddle.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ effective_from: 'immediately' })
        });
        if (!r.ok) console.error('[auth] Paddle cancel failed', s.provider_subscription_id, r.status);
      } catch (err) {
        console.error('[auth] Paddle cancel error', err.message);
      }
    }
  } else if (subs.length) {
    console.warn(`[auth] user ${req.userId} deleted with an active Paddle subscription and no PADDLE_API_KEY to cancel it`);
  }

  await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

// Always the same response whether or not the email is registered, so this
// endpoint can't be used to discover who has an account.
router.post('/forgot-password', credentialLimiter, async (req, res) => {
  const GENERIC = 'If an account exists for that email, we’ve sent a reset link. Check your inbox (and spam).';
  const { email } = req.body || {};
  if (!email || !isValidEmail(String(email).trim())) return fail(res, 400, 'invalid_email', 'Please enter a valid email address.');

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, name FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    const user = rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3',
        [hashToken(token), new Date(Date.now() + RESET_TOKEN_TTL_MS), user.id]
      );
      // Built from configuration, never from the Host header — otherwise an
      // attacker could get us to email a victim a link to their own site.
      const resetLink = `${config.publicUrl}/?resetToken=${token}`;
      await sendMail({
        to: normalizedEmail,
        subject: 'Reset your DocGen AI password',
        text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your DocGen AI password. This link expires in 1 hour:\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
      });
    }
  } catch (err) {
    console.error('Forgot-password error:', err);
  }
  res.json({ message: GENERIC });
});

router.post('/reset-password', credentialLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return fail(res, 400, 'invalid_input', 'This reset link is incomplete.');
  if (!password || String(password).length < 8) return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > now()',
    [hashToken(String(token))]
  );
  if (!rows[0]) return fail(res, 400, 'reset_invalid', 'This reset link is invalid or has expired. Request a new one.');

  const passwordHash = await bcrypt.hash(String(password), 10);
  await pool.query(
    'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2',
    [passwordHash, rows[0].id]
  );
  res.json({ message: 'Your password has been reset. You can sign in now.' });
});

module.exports = router;
