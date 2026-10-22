const contactModel = require('../models/contactModel');
const newsletterModel = require('../models/newsletterModel');

const TYPES = ['text', 'number', 'date', 'select', 'boolean'];
// Built-in merge tags and directory details: a custom field cannot reuse these names.
const RESERVED = new Set(['firstname', 'lastname', 'email', 'registeredat', 'name', 'department', 'role', 'location', 'manager', 'joindate', 'source', 'tags', 'notes', 'id']);
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const keyFromLabel = (label) => {
  const words = String(label || '').normalize('NFKD').replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[a-zA-Z]/.test(key) ? key.slice(0, 40) : `field${key}`.slice(0, 40);
};

const cleanOptions = (options) => [...new Set((Array.isArray(options) ? options : [])
  .map((o) => String(o || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 50);

/** Turns a submitted value into the field's type; returns { ok, value } or { ok: false, message }. */
const coerce = (field, raw) => {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  switch (field.type) {
    case 'number': {
      const n = Number(String(raw).replace(/,/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: `"${field.label}" must be a number.` };
    }
    case 'boolean': {
      const v = String(raw).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(v) || raw === true) return { ok: true, value: true };
      if (['false', 'no', 'n', '0'].includes(v) || raw === false) return { ok: true, value: false };
      return { ok: false, message: `"${field.label}" must be yes or no.` };
    }
    case 'date': {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? { ok: false, message: `"${field.label}" must be a date.` } : { ok: true, value: d.toISOString().slice(0, 10) };
    }
    case 'select': {
      const match = (field.options || []).find((o) => o.toLowerCase() === String(raw).trim().toLowerCase());
      return match ? { ok: true, value: match } : { ok: false, message: `"${String(raw)}" is not one of the choices for "${field.label}".` };
    }
    default:
      return { ok: true, value: String(raw).trim().slice(0, 500) };
  }
};

const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : [])
  .map((t) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))].slice(0, 50);

/** Validates { key: value } against the defined fields. */
const coerceValues = (values, fields, { lenient = false } = {}) => {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out = {};
  for (const [key, raw] of Object.entries(values || {})) {
    const field = byKey.get(key);
    if (!field) { if (lenient) continue; return { error: `Unknown field "${key}".` }; }
    const result = coerce(field, raw);
    if (!result.ok) { if (lenient) continue; return { error: result.message }; }
    out[key] = result.value;
  }
  return { values: out };
};

/* --------------------------------- fields --------------------------------- */

const listFields = async (req, res, next) => {
  try { res.json(await contactModel.listFields()); } catch (error) { next(error); }
};

const createField = async (req, res, next) => {
  try {
    const label = String(req.body?.label || '').trim().slice(0, 80);
    const type = TYPES.includes(req.body?.type) ? req.body.type : 'text';
    const key = String(req.body?.key || '').trim() || keyFromLabel(label);
    const options = cleanOptions(req.body?.options);
    if (!label) return res.status(400).json({ message: 'Give the field a name.' });
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)) return res.status(400).json({ message: 'The merge tag can use letters and numbers only, starting with a letter.' });
    if (RESERVED.has(key.toLowerCase())) return res.status(400).json({ message: `"${key}" is already a built-in detail. Choose another name.` });
    if (type === 'select' && !options.length) return res.status(400).json({ message: 'Add at least one choice for a dropdown field.' });
    const existing = (await contactModel.listFields()).find((f) => f.key.toLowerCase() === key.toLowerCase());
    if (existing) return res.status(409).json({ message: `A field with the merge tag {{${existing.key}}} already exists.` });
    res.status(201).json(await contactModel.createField({ key, label, type, options, description: String(req.body?.description || '').trim().slice(0, 255) }));
  } catch (error) { next(error); }
};

const updateField = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const field = await contactModel.findField(id);
    if (!field) return res.status(404).json({ message: 'Field not found.' });
    const label = String(req.body?.label ?? field.label).trim().slice(0, 80);
    if (!label) return res.status(400).json({ message: 'Give the field a name.' });
    const options = field.type === 'select' ? cleanOptions(req.body?.options ?? field.options) : [];
    if (field.type === 'select' && !options.length) return res.status(400).json({ message: 'Add at least one choice for a dropdown field.' });
    const position = req.body?.position === undefined ? null : parseInt(req.body.position, 10);
    res.json(await contactModel.updateField(id, { label, options, description: String(req.body?.description ?? field.description ?? '').trim().slice(0, 255), position }));
  } catch (error) { next(error); }
};

const deleteField = async (req, res, next) => {
  try {
    const deleted = await contactModel.deleteField(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ message: 'Field not found.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

/* -------------------------------- contacts -------------------------------- */

const listContacts = async (req, res, next) => {
  try { res.json(await contactModel.listContactsDetailed()); } catch (error) { next(error); }
};

/** Bulk (or single) update of field values, tags and notes. */
const updateDetails = async (req, res, next) => {
  try {
    const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : []).map((e) => String(e).trim().toLowerCase()).filter(isValidEmail))].slice(0, 5000);
    if (!emails.length) return res.status(400).json({ message: 'Choose at least one contact.' });
    const known = new Set(await newsletterModel.findOrganisationEmails());
    const unknown = emails.find((e) => !known.has(e));
    if (unknown) return res.status(400).json({ message: `${unknown} is not in your contacts.` });
    const { values, error } = coerceValues(req.body?.values, await contactModel.listFields());
    if (error) return res.status(400).json({ message: error });
    const notes = req.body?.notes === undefined ? undefined : String(req.body.notes || '').slice(0, 2000);
    const updated = await contactModel.updateAttributes({ emails, values, addTags: cleanTags(req.body?.addTags), removeTags: cleanTags(req.body?.removeTags), notes });
    res.json({ updated });
  } catch (error) { next(error); }
};

const renameTag = async (req, res, next) => {
  try {
    const from = String(req.body?.from || '').trim();
    const to = cleanTags([req.body?.to])[0] || '';
    if (!from) return res.status(400).json({ message: 'Choose a tag.' });
    res.json({ updated: await contactModel.renameTag(from, to) });
  } catch (error) { next(error); }
};

/** Edit the name or email of a contact added by hand or imported (organisation members come from the directory). */
const updateContact = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const current = await contactModel.findContactById(id);
    if (!current) return res.status(404).json({ message: 'Contact not found.' });
    const name = String(req.body?.name ?? current.name).trim();
    const email = String(req.body?.email ?? current.email).trim().toLowerCase();
    if (!name || name.length > 150) return res.status(400).json({ message: 'Name is required and must be 150 characters or fewer.' });
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (email !== current.email && (await newsletterModel.findOrganisationEmails()).includes(email)) return res.status(409).json({ message: `${email} is already in your contacts.` });
    const updated = await contactModel.updateContact(id, { name, email });
    await contactModel.moveAttributes(current.email, email);
    res.json(updated);
  } catch (error) { next(error); }
};

const bulkDelete = async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.contactIds) ? req.body.contactIds : []).map((v) => parseInt(v, 10)).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ message: 'Choose at least one contact you added or imported. Organisation members cannot be deleted here.' });
    const deleted = await contactModel.deleteContactsByIds(ids);
    // Keep details of people who are still organisation members under the same email.
    const remaining = new Set(await newsletterModel.findOrganisationEmails());
    await contactModel.deleteAttributes(deleted.map((d) => d.email).filter((e) => !remaining.has(e)));
    res.json({ deleted: deleted.length });
  } catch (error) { next(error); }
};

/**
 * CSV import with custom fields and tags. Rows: { name, email, fields: { key: value }, tags: [] }.
 * New addresses become contacts; details are applied to new and existing contacts alike.
 */
const importContacts = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.contacts) ? req.body.contacts.slice(0, 10000) : [];
    const contacts = rows
      .map((row) => ({
        name: String(row?.name || '').trim().slice(0, 150) || String(row?.email || '').trim(),
        email: String(row?.email || '').trim().toLowerCase(),
        fields: row?.fields || {},
        tags: cleanTags(Array.isArray(row?.tags) ? row.tags : String(row?.tags || '').split(/[;|]/))
      }))
      .filter((row) => isValidEmail(row.email));
    if (!contacts.length) return res.status(400).json({ message: 'No valid contacts found to import. Each row needs at least a valid email address.' });
    const result = await newsletterModel.bulkImportNewsletterContacts(contacts, req.user.id);
    const fields = await contactModel.listFields();
    const listTags = cleanTags(req.body?.tags);
    let detailsUpdated = 0;
    for (const row of contacts) {
      const { values } = coerceValues(row.fields, fields, { lenient: true });
      Object.keys(values).forEach((k) => { if (values[k] === null) delete values[k]; }); // empty cells never wipe existing data
      const addTags = [...new Set([...row.tags, ...listTags])];
      if (Object.keys(values).length || addTags.length) {
        await contactModel.updateAttributes({ emails: [row.email], values, addTags });
        detailsUpdated += 1;
      }
    }
    res.status(201).json({ ...result, detailsUpdated });
  } catch (error) { next(error); }
};

module.exports = { listFields, createField, updateField, deleteField, listContacts, updateDetails, renameTag, updateContact, bulkDelete, importContacts, keyFromLabel };
