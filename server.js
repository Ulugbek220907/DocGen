require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./auth-routes');

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
app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);

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
