const nodemailer = require('nodemailer');

/*
 * One SMTP setup for every email the app sends (campaigns, test sends, automations,
 * OTP and document notifications).
 *
 * Why this exists: the test email failed with
 *   "ssl3_get_record:wrong version number" / "tls_validate_record_header:wrong version number"
 * That OpenSSL error means the app opened an encrypted (implicit TLS) connection to a
 * port that speaks plain SMTP first and upgrades with STARTTLS (587, 25, 2525).
 * It happens when SMTP_SECURE=true is combined with such a port. The other mailers in the
 * app hard-coded `secure: false`, which is why OTP and document emails kept working.
 *
 * Rules applied here:
 *   - Port 465 always uses implicit TLS. Every other port uses STARTTLS when the server offers it.
 *   - SMTP_SECURE is still honoured when it agrees with the port; a conflicting value is
 *     ignored with a warning in the server log instead of breaking every send.
 *   - If the server still answers with a TLS version error, the send is retried once with the
 *     other TLS mode and that mode is remembered for later sends.
 */

const IMPLICIT_TLS_PORT = 465;

const readPort = () => {
  const value = parseInt(String(process.env.SMTP_PORT || '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 587;
};

const readSecureFlag = () => {
  const raw = String(process.env.SMTP_SECURE ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['true', '1', 'yes', 'ssl', 'tls'].includes(raw)) return true;
  if (['false', '0', 'no', 'starttls', 'none'].includes(raw)) return false;
  return null;
};

const resolveSecure = (port, requested) => {
  const portSecure = port === IMPLICIT_TLS_PORT;
  if (requested === null || requested === portSecure) return { secure: portSecure, warning: null };
  // Non-standard ports (e.g. a provider that runs implicit TLS on 2465) can still opt in explicitly.
  if (requested === true && ![25, 587, 2525].includes(port)) return { secure: true, warning: null };
  return {
    secure: portSecure,
    warning: `SMTP_SECURE=${process.env.SMTP_SECURE} does not match SMTP_PORT=${port}. ` +
      `Port ${port} ${portSecure ? 'uses implicit TLS' : 'uses STARTTLS'}, so secure=${portSecure} is used instead. ` +
      `Remove SMTP_SECURE or set it to ${portSecure} to silence this warning.`,
  };
};

const port = readPort();
const { secure: initialSecure, warning } = resolveSecure(port, readSecureFlag());
if (warning) console.warn(`[mailer] ${warning}`);

const buildTransport = (secure) => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure,
  requireTLS: false, // upgrade with STARTTLS when offered, but still work with plain internal relays
  auth: process.env.SMTP_USERNAME ? { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } : undefined,
  tls: { rejectUnauthorized: false },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
});

let currentSecure = initialSecure;
let transport = buildTransport(currentSecure);

const isTlsModeMismatch = (error) => {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.reason || ''}`.toLowerCase();
  return text.includes('wrong version number')
    || text.includes('err_ssl_wrong_version_number')
    || text.includes('unknown protocol')
    || text.includes('packet length too long')
    || (currentSecure === false && port === IMPLICIT_TLS_PORT && /greeting never received|etimedout/.test(text));
};

const isConfigured = () => Boolean(String(process.env.SMTP_HOST || '').trim());

class MailConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MailConfigError';
    this.status = 503;
    this.expose = true;
  }
}

/** Sends through the shared transport, retrying once with the other TLS mode on a TLS version error. */
const sendMail = async (message) => {
  if (!isConfigured()) throw new MailConfigError('The email service is not configured: SMTP_HOST is missing on the server.');
  try {
    return await transport.sendMail(message);
  } catch (error) {
    if (!isTlsModeMismatch(error)) throw error;
    const fallbackSecure = !currentSecure;
    console.warn(`[mailer] TLS mode mismatch on ${process.env.SMTP_HOST}:${port} (secure=${currentSecure}). Retrying with secure=${fallbackSecure}.`);
    const fallback = buildTransport(fallbackSecure);
    const info = await fallback.sendMail(message);
    transport.close?.();
    transport = fallback;
    currentSecure = fallbackSecure;
    console.warn(`[mailer] secure=${fallbackSecure} works for port ${port}; using it from now on. Update SMTP_SECURE in .env to match.`);
    return info;
  }
};

/** Keeps the old `mailer.sendMail(...)` call sites working unchanged. */
const mailer = { sendMail, verify: () => transport.verify(), close: () => transport.close?.() };

/** Turns SMTP / network errors into a status code and a message an administrator can act on. */
const describeMailError = (error) => {
  if (error instanceof MailConfigError) return { status: 503, message: error.message };
  const code = String(error?.code || '');
  const text = `${error?.message || ''}`;
  const lower = text.toLowerCase();
  const where = process.env.SMTP_HOST ? `${process.env.SMTP_HOST}:${port}` : `port ${port}`;
  if (lower.includes('wrong version number') || lower.includes('ssl routines')) {
    return { status: 502, message: `Email service misconfigured: the TLS setting does not match port ${port} on ${where}. Use SMTP_PORT=465 with SMTP_SECURE=true, or SMTP_PORT=587 with SMTP_SECURE=false.` };
  }
  if (code === 'EAUTH' || error?.responseCode === 535 || lower.includes('invalid login') || lower.includes('authentication')) {
    return { status: 502, message: 'Email service rejected the login. Check SMTP_USERNAME and SMTP_PASSWORD (for Gmail or Microsoft 365, use an app password).' };
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code) || /econnrefused|enotfound|eai_again|ehostunreach|getaddrinfo/.test(lower)) {
    return { status: 502, message: `Cannot reach the email server at ${where}. Check SMTP_HOST and SMTP_PORT, and that the server can make outbound connections.` };
  }
  if (code === 'ETIMEDOUT' || lower.includes('greeting never received') || lower.includes('timeout')) {
    return { status: 504, message: `The email server at ${where} did not respond in time. The port may be blocked by a firewall, or the TLS setting may be wrong for this port.` };
  }
  if (code === 'EENVELOPE' || (error?.responseCode >= 500 && error?.responseCode < 600)) {
    return { status: 502, message: `The email server refused the message: ${error?.response || text}`.slice(0, 400) };
  }
  if (error?.responseCode >= 400 && error?.responseCode < 500) {
    return { status: 503, message: `The email server is temporarily refusing mail (${error.responseCode}). Try again in a few minutes.` };
  }
  return { status: 502, message: `The email could not be sent: ${text || 'unknown mail server error'}`.slice(0, 400) };
};

/** Logged once at startup so a broken SMTP setup shows up in the server log, not first in the UI. */
const verifyMailer = async () => {
  if (!isConfigured()) {
    console.warn('[mailer] SMTP_HOST is not set; emails cannot be sent.');
    return false;
  }
  try {
    await transport.verify();
    console.log(`[mailer] SMTP ready: ${process.env.SMTP_HOST}:${port} (${currentSecure ? 'implicit TLS' : 'STARTTLS / plain'})`);
    return true;
  } catch (error) {
    if (isTlsModeMismatch(error)) {
      try {
        const fallback = buildTransport(!currentSecure);
        await fallback.verify();
        transport.close?.();
        transport = fallback;
        currentSecure = !currentSecure;
        console.warn(`[mailer] SMTP ready after switching TLS mode: ${process.env.SMTP_HOST}:${port} secure=${currentSecure}. Update SMTP_SECURE in .env to match.`);
        return true;
      } catch { /* report the original error below */ }
    }
    console.error(`[mailer] SMTP check failed: ${describeMailError(error).message}`);
    return false;
  }
};

const fromAddress = () => process.env.SMTP_FROM || process.env.SMTP_USERNAME;

// When a sender domain is authenticated (SPF + DKIM) and selected as default,
// mail is sent from that domain and signed with its DKIM private key.
const getSenderIdentity = async () => {
  const senderDomain = await require('../models/senderDomainModel').getDefault();
  if (!senderDomain) return { from: fromAddress() };
  const { decrypt } = require('../services/automation/dkimKeyCrypto');
  const configuredFrom = fromAddress() || 'campaigns@example.com';
  const localPart = configuredFrom.split('@')[0] || 'campaigns';
  return {
    from: `${localPart}@${senderDomain.domain}`,
    dkim: {
      domainName: senderDomain.domain,
      keySelector: senderDomain.dkimSelector,
      privateKey: decrypt(senderDomain.dkimPrivateKeyEncrypted),
    },
  };
};

module.exports = { mailer, sendMail, fromAddress, getSenderIdentity, describeMailError, verifyMailer, MailConfigError, _internal: { resolveSecure } };
