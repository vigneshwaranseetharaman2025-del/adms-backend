const pool = require('../config/db');
const { fromAddress, getSenderIdentity } = require('../config/mailer');

/**
 * Which "From" identities campaigns may use, and the headers for a chosen one.
 *
 * A sender address is authorised when it is:
 *   1. the address the SMTP account is configured to send as (SMTP_FROM, or SMTP_USERNAME), or
 *   2. any address at a sender domain that passed SPF and DKIM checks under Domain authentication
 *      (those messages are DKIM-signed with that domain's key).
 * Addresses at domains still waiting for verification, or at any other domain, are refused, so
 * nobody can send campaigns as an arbitrary address. SMTP credentials never leave the server.
 */

const DEFAULT_SENDER_NAME = () => String(process.env.SENDER_NAME || process.env.SMTP_FROM_NAME || 'Aithent - Calypso').trim();
const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const bareAddress = (value) => {
  const text = String(value || '').trim();
  const angle = /<([^>]+)>/.exec(text);
  return (angle ? angle[1] : text).trim().toLowerCase();
};

/** Display name safe for a header: no line breaks, quotes or angle brackets. */
const cleanName = (value) => String(value || '').replace(/[\r\n\t"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

class SenderError extends Error {
  constructor(message, code = 'SENDER_NOT_AUTHORISED') {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

const tableExists = async (name) => Boolean((await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t);

const listDomains = async () => {
  if (!(await tableExists('newsletter_sender_domains'))) return [];
  return (await pool.query(
    `SELECT domain, verified, spf_verified AS "spfVerified", dkim_verified AS "dkimVerified", is_default AS "isDefault"
     FROM newsletter_sender_domains ORDER BY is_default DESC, domain`
  )).rows;
};

/** What the compose screen and the resend dialog need. No secrets. */
const getSenderOptions = async () => {
  const smtpAddress = bareAddress(fromAddress());
  const identity = await getSenderIdentity().catch(() => ({ from: fromAddress() }));
  const defaultEmail = bareAddress(identity?.from) || smtpAddress;
  const domains = await listDomains();
  return {
    defaultName: DEFAULT_SENDER_NAME(),
    defaultEmail,
    replyToSupported: true,
    smtpAddress: smtpAddress || null,
    domains: domains.map((d) => ({ domain: d.domain, verified: Boolean(d.verified), spfVerified: Boolean(d.spfVerified), dkimVerified: Boolean(d.dkimVerified), isDefault: Boolean(d.isDefault) })),
    configured: Boolean(smtpAddress || domains.length)
  };
};

/** Explains whether an address may be used, without sending anything. */
const checkSenderEmail = async (email) => {
  const address = bareAddress(email);
  if (!EMAIL_RE.test(address)) return { ok: false, status: 'invalid', message: 'Enter a valid sender email address.' };
  const smtpAddress = bareAddress(fromAddress());
  if (smtpAddress && address === smtpAddress) return { ok: true, status: 'authorised', source: 'smtp' };
  const domain = address.split('@')[1];
  const match = (await listDomains()).find((d) => d.domain.toLowerCase() === domain);
  if (match?.verified) return { ok: true, status: 'authorised', source: 'domain', domain: match.domain };
  if (match) {
    return { ok: false, status: 'pending', message: `${match.domain} is not verified yet (SPF ${match.spfVerified ? 'OK' : 'missing'}, DKIM ${match.dkimVerified ? 'OK' : 'missing'}). Finish Domain authentication before sending from it.` };
  }
  return {
    ok: false,
    status: 'not_allowed',
    message: `You can only send from ${smtpAddress || 'the configured sender address'}${''} or an address at a verified sender domain. Add and verify ${domain} under Domain authentication to use it.`
  };
};

/**
 * Builds the message headers for a chosen identity. Throws SenderError when the address is not authorised.
 * Missing values fall back to the defaults (Aithent - Calypso and the configured address).
 */
const resolveSender = async ({ fromName, fromEmail, replyTo } = {}) => {
  const options = await getSenderOptions();
  const name = cleanName(fromName) || options.defaultName;
  const email = bareAddress(fromEmail) || options.defaultEmail;
  if (!email) throw new SenderError('No sender address is configured on the server (SMTP_FROM). Ask an administrator to set it.', 'SENDER_NOT_CONFIGURED');
  const check = await checkSenderEmail(email);
  if (!check.ok) throw new SenderError(check.message, check.status === 'pending' ? 'SENDER_NOT_VERIFIED' : 'SENDER_NOT_AUTHORISED');

  let reply = null;
  if (replyTo && String(replyTo).trim()) {
    reply = bareAddress(replyTo);
    if (!EMAIL_RE.test(reply)) throw new SenderError('The reply-to address is not a valid email address.', 'REPLY_TO_INVALID');
  }

  const headers = { from: { name, address: email } };
  if (reply) headers.replyTo = reply;
  if (check.source === 'domain') {
    const { rows: [key] } = await pool.query(
      `SELECT domain, dkim_selector AS "dkimSelector", dkim_private_key_encrypted AS "dkimPrivateKeyEncrypted"
       FROM newsletter_sender_domains WHERE LOWER(domain) = $1 AND verified = TRUE LIMIT 1`,
      [check.domain.toLowerCase()]
    );
    if (key?.dkimPrivateKeyEncrypted) {
      const { decrypt } = require('./automation/dkimKeyCrypto');
      headers.dkim = { domainName: key.domain, keySelector: key.dkimSelector, privateKey: decrypt(key.dkimPrivateKeyEncrypted) };
    }
  }
  return { headers, name, email, replyTo: reply };
};

module.exports = { getSenderOptions, checkSenderEmail, resolveSender, SenderError, bareAddress, cleanName, DEFAULT_SENDER_NAME };
