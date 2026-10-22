const pool = require('../config/db');

const FIELD_COLUMNS = `id, key, label, type, options, description, position, created_at AS "createdAt", updated_at AS "updatedAt"`;

const tableExists = async (name) => Boolean((await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t);

/* ------------------------------- custom fields ------------------------------- */

const listFields = async () => (await pool.query(`SELECT ${FIELD_COLUMNS} FROM contact_fields ORDER BY position, id`)).rows;

const findField = async (id) => (await pool.query(`SELECT ${FIELD_COLUMNS} FROM contact_fields WHERE id = $1`, [id])).rows[0] || null;

const createField = async ({ key, label, type, options, description }) => (await pool.query(
  `INSERT INTO contact_fields (key, label, type, options, description, position)
   VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE((SELECT MAX(position) + 1 FROM contact_fields), 0))
   RETURNING ${FIELD_COLUMNS}`,
  [key, label, type, JSON.stringify(options || []), description || null]
)).rows[0];

const updateField = async (id, { label, options, description, position }) => (await pool.query(
  `UPDATE contact_fields SET label = $2, options = $3::jsonb, description = $4, position = COALESCE($5, position), updated_at = NOW()
   WHERE id = $1 RETURNING ${FIELD_COLUMNS}`,
  [id, label, JSON.stringify(options || []), description || null, position ?? null]
)).rows[0] || null;

/** Removes the field and every value stored for it. */
const deleteField = async (id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [field] } = await client.query('DELETE FROM contact_fields WHERE id = $1 RETURNING key', [id]);
    if (field) await client.query('UPDATE contact_attributes SET field_values = field_values - $1, updated_at = NOW() WHERE field_values ? $1', [field.key]);
    await client.query('COMMIT');
    return field || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/* ------------------------------- contacts ------------------------------- */

/**
 * Everyone the campaign module can email, with what is known about them:
 * directory details for organisation members, custom field values, tags, notes and engagement.
 */
const listContactsDetailed = async () => {
  const people = (await pool.query(
    `SELECT id, contact_id AS "contactId", name, email, source, department, role, location, manager, "joinDate", "addedAt", "importedFrom" FROM (
       SELECT DISTINCT ON (email) * FROM (
         SELECT 'u-' || id AS id, NULL::int AS contact_id, COALESCE(NULLIF(TRIM(full_name), ''), username) AS name, LOWER(TRIM(email)) AS email,
                'user' AS source, department, role, location, manager, join_date AS "joinDate", created_at AS "addedAt", NULL::text AS "importedFrom"
         FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''
         UNION ALL
         SELECT 'c-' || id, id, name, LOWER(TRIM(email)), 'contact', NULL, NULL, NULL, NULL, NULL, created_at, source
         FROM newsletter_contacts
       ) combined
       ORDER BY email, (source = 'user') DESC
     ) deduped
     ORDER BY name, email`
  )).rows;

  const attributes = new Map((await pool.query(
    `SELECT email, field_values AS "fieldValues", tags, notes, updated_at AS "updatedAt" FROM contact_attributes`
  )).rows.map((row) => [row.email, row]));

  const engagementParts = [];
  if (await tableExists('newsletter_tracking')) {
    engagementParts.push(`SELECT LOWER(email) AS email, sent_at::timestamptz AS sent_at, opened_at::timestamptz AS opened_at, clicked_at::timestamptz AS clicked_at FROM newsletter_tracking`);
  }
  if (await tableExists('email_logs')) {
    engagementParts.push(`SELECT LOWER(recipient_email), sent_at::timestamptz, opened_at::timestamptz, clicked_at::timestamptz FROM email_logs`);
  }
  const engagement = new Map();
  if (engagementParts.length) {
    const { rows } = await pool.query(
      `SELECT email, COUNT(sent_at)::int AS sent, COUNT(opened_at)::int AS opened, COUNT(clicked_at)::int AS clicked,
              MAX(GREATEST(sent_at, opened_at, clicked_at)) AS "lastActivityAt", MAX(opened_at) AS "lastOpenedAt"
       FROM (${engagementParts.join(' UNION ALL ')}) e GROUP BY email`
    );
    rows.forEach((row) => engagement.set(row.email, row));
  }

  const { rows: groups } = await pool.query(`SELECT id, member_emails AS "memberEmails" FROM newsletter_groups`);
  const listsByEmail = new Map();
  groups.forEach((group) => (group.memberEmails || []).forEach((email) => {
    const key = String(email).toLowerCase();
    listsByEmail.set(key, [...(listsByEmail.get(key) || []), group.id]);
  }));

  return people.map((person) => {
    const attr = attributes.get(person.email);
    const eng = engagement.get(person.email);
    return {
      ...person,
      fields: attr?.fieldValues || {},
      tags: attr?.tags || [],
      notes: attr?.notes || '',
      listIds: listsByEmail.get(person.email) || [],
      engagement: eng ? { sent: eng.sent, opened: eng.opened, clicked: eng.clicked, lastActivityAt: eng.lastActivityAt, lastOpenedAt: eng.lastOpenedAt } : { sent: 0, opened: 0, clicked: 0, lastActivityAt: null, lastOpenedAt: null }
    };
  });
};

/**
 * One update applied to many contacts: set or clear field values, add or remove tags, optionally set notes.
 * values: { key: value } (null clears). Contacts without stored details get a row.
 */
const updateAttributes = async ({ emails, values = {}, addTags = [], removeTags = [], notes }) => {
  const setValues = {};
  const clearKeys = [];
  Object.entries(values).forEach(([key, value]) => { if (value === null) clearKeys.push(key); else setValues[key] = value; });
  const hasNotes = notes !== undefined;
  const { rowCount } = await pool.query(
    `INSERT INTO contact_attributes (email, field_values, tags, notes, updated_at)
     SELECT e, $2::jsonb, ARRAY(SELECT DISTINCT t FROM unnest($3::text[]) t WHERE t <> ALL($4::text[]) ORDER BY t),
            CASE WHEN $6::boolean THEN $7 ELSE NULL END, NOW()
     FROM unnest($1::text[]) e
     ON CONFLICT (email) DO UPDATE SET
       field_values = (contact_attributes.field_values || $2::jsonb) - $5::text[],
       tags = ARRAY(SELECT DISTINCT t FROM unnest(contact_attributes.tags || $3::text[]) t WHERE t <> ALL($4::text[]) ORDER BY t),
       notes = CASE WHEN $6::boolean THEN $7 ELSE contact_attributes.notes END,
       updated_at = NOW()`,
    [emails, JSON.stringify(setValues), addTags, removeTags, clearKeys, hasNotes, hasNotes ? notes : null]
  );
  return rowCount;
};

/** Renames every tag occurrence, or deletes it when `to` is empty. */
const renameTag = async (from, to) => (await pool.query(
  `UPDATE contact_attributes
   SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_replace(tags, $1, NULLIF($2, ''))) t WHERE t IS NOT NULL ORDER BY t), updated_at = NOW()
   WHERE $1 = ANY(tags)`,
  [from, to || '']
)).rowCount;

const updateContact = async (id, { name, email }) => (await pool.query(
  `UPDATE newsletter_contacts SET name = $2, email = $3 WHERE id = $1
   RETURNING 'c-' || id AS id, id AS "contactId", name, email, 'contact' AS source`,
  [id, name, email]
)).rows[0] || null;

const findContactById = async (id) => (await pool.query('SELECT id, name, LOWER(email) AS email FROM newsletter_contacts WHERE id = $1', [id])).rows[0] || null;

/** Moves stored details when an external contact's email address changes. */
const moveAttributes = async (fromEmail, toEmail) => {
  if (fromEmail === toEmail) return;
  await pool.query(
    `INSERT INTO contact_attributes (email, field_values, tags, notes, updated_at)
     SELECT $2, field_values, tags, notes, NOW() FROM contact_attributes WHERE email = $1
     ON CONFLICT (email) DO NOTHING`,
    [fromEmail, toEmail]
  );
  await pool.query('DELETE FROM contact_attributes WHERE email = $1', [fromEmail]);
};

const deleteContactsByIds = async (ids) => (await pool.query(
  'DELETE FROM newsletter_contacts WHERE id = ANY($1::int[]) RETURNING id, LOWER(email) AS email', [ids]
)).rows;

const deleteAttributes = async (emails) => pool.query('DELETE FROM contact_attributes WHERE email = ANY($1::text[])', [emails]);

/** Custom values of one person, for {{mergeTags}} in emails. */
const findAttributes = async (email) => (await pool.query(
  'SELECT field_values AS "fieldValues", tags FROM contact_attributes WHERE email = $1', [email]
)).rows[0] || null;

module.exports = {
  listFields, findField, createField, updateField, deleteField,
  listContactsDetailed, updateAttributes, renameTag, updateContact, findContactById, moveAttributes, deleteContactsByIds, deleteAttributes, findAttributes
};
