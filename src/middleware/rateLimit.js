/**
 * Small fixed-window rate limiter kept in memory (one API process). Enough to stop a stuck client or a
 * replaying webhook from hammering the send endpoints; use a shared store if the API runs on several nodes.
 */
const rateLimit = ({ windowMs = 60000, max = 30, key = (req) => req.user?.id || req.ip, message = 'Too many requests. Wait a moment and try again.' } = {}) => {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref?.();
  return (req, res, next) => {
    const k = String(key(req));
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || entry.reset <= now) { hits.set(k, { count: 1, reset: now + windowMs }); return next(); }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ message, code: 'RATE_LIMITED' });
    }
    return next();
  };
};

module.exports = { rateLimit };
