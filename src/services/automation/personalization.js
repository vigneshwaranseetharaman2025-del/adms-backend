const pool = require('../../config/db');

const MERGE_TAGS = ['firstName', 'lastName', 'email', 'registeredAt'];

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const splitName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
};

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: process.env.AUTOMATION_DISPLAY_TIMEZONE || undefined,
  });
};

/**
 * Custom contact field values for {{mergeTags}}. Every defined field is present (empty when the
 * person has no value), so a tag such as {{employeeType|Team}} always resolves to a value or its fallback.
 */
const loadCustomValues = async (email) => {
  try {
    const [{ rows: fields }, { rows: [attr] }] = await Promise.all([
      pool.query('SELECT key, type FROM contact_fields'),
      pool.query('SELECT field_values AS "fieldValues" FROM contact_attributes WHERE email = $1', [email])
    ]);
    const values = attr?.fieldValues || {};
    return Object.fromEntries(fields.map((f) => {
      const v = values[f.key];
      if (v === undefined || v === null || v === '') return [f.key, ''];
      if (f.type === 'boolean') return [f.key, v ? 'Yes' : 'No'];
      if (f.type === 'date') return [f.key, formatDate(v)];
      return [f.key, String(v)];
    }));
  } catch {
    return {}; // custom fields are optional for the engine
  }
};

/**
 * Looks up a recipient across the two places the newsletter module already
 * keeps people: organisation users and newsletter contacts (users win).
 */
const getRecipientProfile = async (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  const user = (await pool.query(
    `SELECT id, username, full_name, email, department, role, location, created_at, activated_at
     FROM users WHERE LOWER(TRIM(email)) = $1 ORDER BY id LIMIT 1`, [normalized]
  )).rows[0];
  const custom = await loadCustomValues(normalized);
  if (user) {
    const { firstName, lastName } = splitName(user.full_name || user.username);
    return {
      custom,
      userId: user.id, email: normalized, firstName, lastName,
      registeredAt: user.created_at, activatedAt: user.activated_at,
      department: user.department || '', role: user.role || '', location: user.location || '',
      source: 'user',
    };
  }
  let contact = null;
  try {
    contact = (await pool.query(
      `SELECT id, name, email, created_at FROM newsletter_contacts WHERE LOWER(TRIM(email)) = $1 LIMIT 1`, [normalized]
    )).rows[0];
  } catch {
    contact = null; // contacts table is optional for the engine
  }
  const { firstName, lastName } = splitName(contact?.name || '');
  return {
    custom,
    userId: null, email: normalized, firstName, lastName,
    registeredAt: contact?.created_at || null, activatedAt: null,
    department: '', role: '', location: '', source: contact ? 'contact' : 'unknown',
  };
};

/**
 * Replaces {{firstName}}, {{lastName}}, {{email}}, {{registeredAt}} and custom contact fields ({{key}}).
 * Supports a fallback: {{firstName|there}}. Unknown tags are left untouched.
 */
const renderTemplate = (text, profile, { html = false } = {}) => String(text || '').replace(
  /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g,
  (match, tag, fallback) => {
    const isCustom = Boolean(profile?.custom) && Object.prototype.hasOwnProperty.call(profile.custom, tag) && !MERGE_TAGS.includes(tag);
    if (!MERGE_TAGS.includes(tag) && !isCustom) return match;
    let value = isCustom ? profile.custom[tag] : tag === 'registeredAt' ? formatDate(profile?.registeredAt) : profile?.[tag];
    if (!value) value = fallback ?? '';
    return html ? escapeHtml(value) : String(value);
  }
);

/** Same link/pixel tracking approach the newsletter sender uses, on automation routes. */
const addTracking = (html, token, apiOrigin) => {
  const withLinks = String(html || '').replace(
    /href\s*=\s*"(https?:\/\/[^"]+)"/gi,
    (match, url) => `href="${apiOrigin}/api/automations/click/${token}?u=${encodeURIComponent(url)}"`
  );
  const pixel = `<img src="${apiOrigin}/api/automations/track/${token}" width="1" height="1" alt="" style="display:none" />`;
  return /<\/body>/i.test(withLinks) ? withLinks.replace(/<\/body>/i, `${pixel}</body>`) : `${withLinks}${pixel}`;
};

const apiOrigin = () => (process.env.PUBLIC_API_URL || `https://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

module.exports = { MERGE_TAGS, renderTemplate, getRecipientProfile, addTracking, apiOrigin, escapeHtml, splitName };
