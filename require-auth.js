const jwt = require('jsonwebtoken');

// Protects any route it's attached to — expects "Authorization: Bearer <token>".
// On success sets req.userId (and req.tokenIssuedAt, used for sliding refresh).
module.exports = function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthorized' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    req.tokenIssuedAt = payload.iat;
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'session_expired' });
  }
};
