/**
 * Where open pixels and click links in campaign emails point.
 *
 * Recipients' mail apps (and Gmail's image proxy) must be able to reach this address. When it is a private
 * or local address (192.168.x.x, 10.x.x.x, localhost) only people inside the network can load it: opens
 * from everyone else are never recorded, and rewritten links would not open at all. So:
 *  - set PUBLIC_API_URL to the public HTTPS address of this API (e.g. https://adms.aithent.com:5000);
 *  - until then, links are left as they are (clicks not tracked) instead of being broken.
 *  CAMPAIGN_TRACK_CLICKS=true|false overrides the automatic choice.
 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i;

const hostOf = (origin) => { try { return new URL(origin).hostname; } catch { return ''; } };

const trackingOriginFor = (req) => {
  const configured = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return req ? `${req.protocol}://${req.get('host')}` : null;
};

const trackingStatus = (origin) => {
  const isPrivate = !origin || PRIVATE_HOST.test(hostOf(origin));
  const override = String(process.env.CAMPAIGN_TRACK_CLICKS || '').trim().toLowerCase();
  const clicks = override === 'true' ? true : override === 'false' ? false : !isPrivate;
  return { origin, private: isPrivate, clicksTracked: clicks, configured: Boolean(String(process.env.PUBLIC_API_URL || '').trim()) };
};

/** Returns token => { open, click } builders for one send, or null when there is no origin. */
const trackingLinks = (origin) => {
  if (!origin) return null;
  const { clicksTracked } = trackingStatus(origin);
  return (token) => ({
    open: `${origin}/api/newsletters/track/${token}`,
    click: clicksTracked ? (url) => `${origin}/api/newsletters/click/${token}?u=${encodeURIComponent(url)}` : null
  });
};

module.exports = { trackingOriginFor, trackingStatus, trackingLinks };
