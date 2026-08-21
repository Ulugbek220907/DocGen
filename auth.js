const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '30d';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name.trim(), normalizedEmail, passwordHash]
    );
    const user = result.rows[0];

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    const user = result.rows[0];

    // Same error for "no such user" and "wrong password" — don't leak which one.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in. Please try again.' });
  }
});

// Lets the frontend check "is my stored token still valid?" on page load,
// and fetch the current user's info without re-sending credentials.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
