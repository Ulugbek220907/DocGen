// Small fixed-window in-memory rate limiter. Single-instance deployment
// (see render.yaml), so no shared store is needed.
function createLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60000)).unref();

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || 'Too many requests. Please wait a moment and try again.', code: 'rate_limited', retryAfter });
    }
    next();
  };
}

const byIp = req => req.ip || 'unknown';
const byUser = req => (req.userId ? `u:${req.userId}` : `ip:${req.ip}`);

module.exports = { createLimiter, byIp, byUser };
