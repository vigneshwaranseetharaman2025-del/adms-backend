const pool = require('../config/db');

const PUBLIC_FIELDS = `id, domain, verification_token AS "verificationToken", dkim_selector AS "dkimSelector",
  dkim_public_key AS "dkimPublicKey", verified, spf_verified AS "spfVerified", dkim_verified AS "dkimVerified",
  is_default AS "isDefault", created_at AS "createdAt", verified_at AS "verifiedAt", last_checked_at AS "lastCheckedAt"`;

const list = async () => (await pool.query(
  `SELECT ${PUBLIC_FIELDS} FROM newsletter_sender_domains ORDER BY is_default DESC, domain`
)).rows;

const findById = async (id) => (await pool.query(
  `SELECT ${PUBLIC_FIELDS} FROM newsletter_sender_domains WHERE id = $1`, [id]
)).rows[0] || null;

const create = async ({ domain, verificationToken, dkimSelector, dkimPublicKey, dkimPrivateKeyEncrypted }) => {
  const result = await pool.query(
    `INSERT INTO newsletter_sender_domains (domain, verification_token, dkim_selector, dkim_public_key, dkim_private_key_encrypted)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_FIELDS}`,
    [domain, verificationToken, dkimSelector, dkimPublicKey, dkimPrivateKeyEncrypted]
  );
  return result.rows[0];
};

// Stores SPF and DKIM results separately (like Zoho Campaigns). A domain is
// "verified" (authenticated) only when both pass.
const setChecks = async (id, { spf, dkim }) => (await pool.query(
  `UPDATE newsletter_sender_domains
      SET spf_verified = $2::boolean,
          dkim_verified = $3::boolean,
          verified = ($2::boolean AND $3::boolean),
          verified_at = CASE WHEN ($2::boolean AND $3::boolean) THEN COALESCE(verified_at, NOW()) ELSE NULL END,
          last_checked_at = NOW()
    WHERE id = $1 RETURNING ${PUBLIC_FIELDS}`,
  [id, Boolean(spf), Boolean(dkim)]
)).rows[0] || null;

const hasDefault = async () => (await pool.query(
  'SELECT 1 FROM newsletter_sender_domains WHERE is_default = TRUE AND verified = TRUE LIMIT 1'
)).rowCount > 0;

const setDefault = async (id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT verified FROM newsletter_sender_domains WHERE id = $1 FOR UPDATE', [id]);
    if (!selected.rows[0]) { await client.query('ROLLBACK'); return null; }
    if (!selected.rows[0].verified) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE newsletter_sender_domains SET is_default = FALSE');
    const result = await client.query(
      `UPDATE newsletter_sender_domains SET is_default = TRUE WHERE id = $1 RETURNING ${PUBLIC_FIELDS}`, [id]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};

const remove = async (id) => (await pool.query(
  'DELETE FROM newsletter_sender_domains WHERE id = $1 RETURNING id', [id]
)).rowCount > 0;

const getDefault = async () => (await pool.query(
  `SELECT domain, dkim_selector AS "dkimSelector", dkim_private_key_encrypted AS "dkimPrivateKeyEncrypted"
   FROM newsletter_sender_domains WHERE is_default = TRUE AND verified = TRUE LIMIT 1`
)).rows[0] || null;

module.exports = { list, findById, create, setChecks, hasDefault, setDefault, remove, getDefault };