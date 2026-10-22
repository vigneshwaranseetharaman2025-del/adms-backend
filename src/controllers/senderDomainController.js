const crypto = require('crypto');
const dns = require('dns');
const senderDomainModel = require('../models/senderDomainModel');
const dkimKeyCrypto = require('../services/automation/dkimKeyCrypto');

const DKIM_SELECTOR = process.env.DKIM_SELECTOR || 'adms';

/* ------------------------------------------------------------------ */
/* SPF mechanism that authorises the SMTP server actually sending mail. */
/* Known providers -> include:<provider>. Your own server -> a:<host>.  */
/* Optional override in .env: SPF_INCLUDE=zoho.in  or  ip4:1.2.3.4     */
/* ------------------------------------------------------------------ */
const detectSpfMechanism = () => {
  const override = (process.env.SPF_INCLUDE || '').trim().toLowerCase();
  if (override) return /^(include|a|mx|ip4|ip6):/.test(override) ? override : `include:${override}`;
  const host = (process.env.SMTP_HOST || '').trim().toLowerCase();
  const zoho = host.match(/zoho\.([a-z.]+)$/);
  if (zoho) return `include:zoho.${zoho[1]}`;
  if (host.includes('gmail') || host.includes('google')) return 'include:_spf.google.com';
  if (host.includes('office365') || host.includes('outlook')) return 'include:spf.protection.outlook.com';
  if (host.includes('sendgrid')) return 'include:sendgrid.net';
  if (host.includes('amazonaws')) return 'include:amazonses.com';
  if (host.includes('mailgun')) return 'include:mailgun.org';
  if (host.includes('brevo') || host.includes('sendinblue')) return 'include:spf.brevo.com';
  if (host.includes('postmarkapp')) return 'include:spf.mtasv.net';
  if (!host) return null;
  // Own / company mail server: authorise that server directly.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `ip4:${host}` : `a:${host}`;
};
const SPF_MECHANISM = detectSpfMechanism();

const normalizeDomain = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
const isValidDomain = (domain) => domain.length <= 253 && domain.includes('.') &&
  domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));

/* ------------------------------------------------------------------ */
/* DNS helpers: ask public resolvers first (no stale local cache).     */
/* ------------------------------------------------------------------ */
const makeResolver = (servers) => {
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  if (servers) resolver.setServers(servers);
  return resolver;
};
const resolvers = [makeResolver(['8.8.8.8', '1.1.1.1']), makeResolver()];

const readTxt = async (host) => {
  for (const resolver of resolvers) {
    try {
      return (await resolver.resolveTxt(host)).map((parts) => parts.join(''));
    } catch (error) {
      if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; // the record really is not there
      // timeouts / refused / servfail: try the next resolver
    }
  }
  return [];
};

const isSpf = (value) => /^v=spf1(\s|$)/i.test(value.trim());

// Everything that counts as "this server is authorised": the mechanism itself,
// plus (for a:host) an ip4: entry for the server's current IP address.
const acceptedMechanisms = async () => {
  const accepted = [SPF_MECHANISM];
  if (SPF_MECHANISM.startsWith('a:')) {
    try {
      const ips = await resolvers[0].resolve4(SPF_MECHANISM.slice(2));
      ips.forEach((ip) => accepted.push(`ip4:${ip}`, `ip4:${ip}/32`));
    } catch { /* host lookup failed: only the a: form is accepted */ }
  }
  return accepted;
};

const spfAllows = async (record, accepted, depth = 0, seen = new Set()) => {
  if (depth > 5) return false;
  const terms = record.toLowerCase().split(/\s+/).map((term) => term.replace(/^[+\-~?]/, ''));
  if (terms.some((term) => accepted.includes(term))) return true;
  for (const term of terms) {
    let next = null;
    if (term.startsWith('include:')) next = term.slice(8);
    else if (term.startsWith('redirect=')) next = term.slice(9);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    const nested = (await readTxt(next)).find(isSpf);
    if (nested && await spfAllows(nested, accepted, depth + 1, seen)) return true;
  }
  return false;
};

const checkSpf = async (domain) => {
  const records = (await readTxt(domain)).filter(isSpf);
  if (!records.length) return { ok: false, reason: `No SPF record found. Add a TXT record on ${domain}.` };
  if (records.length > 1) return { ok: false, reason: 'More than one SPF record found. A domain may have only one - merge them into a single record.' };
  if (!SPF_MECHANISM) return { ok: true, reason: 'SPF record found (SMTP_HOST is not configured, so its contents were not checked).' };
  if (await spfAllows(records[0], await acceptedMechanisms())) return { ok: true };
  return { ok: false, reason: `SPF record found but it does not contain ${SPF_MECHANISM}. Add it right after v=spf1 in your existing record.` };
};

const checkDkim = async (host, publicKey) => {
  const values = await readTxt(host);
  if (!values.length) return { ok: false, reason: `No DKIM TXT record found at ${host}.` };
  for (const value of values) {
    const match = value.replace(/["\s]/g, '').match(/(?:^|;)p=([^;]*)/i);
    if (match && match[1] === publicKey) return { ok: true };
  }
  return { ok: false, reason: 'A DKIM record exists but its public key does not match. Copy the value again, exactly as shown.' };
};

/* ------------------------------------------------------------------ */
const recordsFor = (entry) => ({
  spf: {
    type: 'TXT',
    host: '@',
    fqdn: entry.domain,
    value: `v=spf1 ${SPF_MECHANISM || 'include:your-smtp-provider.example'} ~all`,
    mechanism: SPF_MECHANISM,
  },
  dkim: {
    type: 'TXT',
    host: `${entry.dkimSelector}._domainkey`,
    fqdn: `${entry.dkimSelector}._domainkey.${entry.domain}`,
    value: `v=DKIM1; k=rsa; p=${entry.dkimPublicKey}`,
  },
});

const present = (entry) => ({ ...entry, records: recordsFor(entry) });

const list = async (req, res, next) => {
  try { res.json((await senderDomainModel.list()).map(present)); } catch (error) { next(error); }
};

const create = async (req, res, next) => {
  try {
    const domain = normalizeDomain(req.body?.domain);
    if (!isValidDomain(domain)) return res.status(400).json({ message: 'Enter a valid domain, such as example.com.' });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const entry = await senderDomainModel.create({
      domain,
      verificationToken: crypto.randomBytes(24).toString('hex'),
      dkimSelector: DKIM_SELECTOR,
      dkimPublicKey: publicKey.toString('base64'),
      dkimPrivateKeyEncrypted: dkimKeyCrypto.encrypt(privateKey),
    });
    res.status(201).json(present(entry));
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'This domain has already been added.' });
    next(error);
  }
};

const verify = async (req, res, next) => {
  try {
    const entry = await senderDomainModel.findById(parseInt(req.params.id, 10));
    if (!entry) return res.status(404).json({ message: 'Sender domain not found.' });
    const records = recordsFor(entry);
    const [spf, dkim] = await Promise.all([
      checkSpf(entry.domain),
      checkDkim(records.dkim.fqdn, entry.dkimPublicKey),
    ]);
    let updated = await senderDomainModel.setChecks(entry.id, { spf: spf.ok, dkim: dkim.ok });
    // First authenticated domain becomes the sending domain automatically.
    if (updated.verified && !(await senderDomainModel.hasDefault())) {
      updated = (await senderDomainModel.setDefault(entry.id)) || updated;
    }
    res.json({
      ...present(updated),
      checks: { spf: spf.ok, dkim: dkim.ok },
      details: { spf: spf.reason || null, dkim: dkim.reason || null },
    });
  } catch (error) { next(error); }
};

const setDefault = async (req, res, next) => {
  try {
    const result = await senderDomainModel.setDefault(parseInt(req.params.id, 10));
    if (result === null) return res.status(404).json({ message: 'Sender domain not found.' });
    if (result === false) return res.status(409).json({ message: 'Authenticate SPF and DKIM before selecting this sender domain.' });
    res.json(present(result));
  } catch (error) { next(error); }
};

const remove = async (req, res, next) => {
  try {
    const removed = await senderDomainModel.remove(parseInt(req.params.id, 10));
    if (!removed) return res.status(404).json({ message: 'Sender domain not found.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

module.exports = { list, create, verify, setDefault, remove };