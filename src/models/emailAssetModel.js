const pool = require('../config/db');

const COLUMNS = `id, name, original_name AS "originalName", storage_key AS "storageKey", mime_type AS "mimeType",
  size_bytes AS "sizeBytes", width, height, source, parent_id AS "parentId", legacy_url AS "legacyUrl",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

const SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  name: 'LOWER(name) ASC, id DESC',
  largest: 'size_bytes DESC, id DESC'
};

const listAssets = async ({ search = '', sort = 'newest' } = {}) => (await pool.query(
  `SELECT ${COLUMNS} FROM email_assets
   WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' OR original_name ILIKE '%' || $1 || '%')
   ORDER BY ${SORTS[sort] || SORTS.newest}`,
  [search]
)).rows;

const findAsset = async (id) => (await pool.query(`SELECT ${COLUMNS} FROM email_assets WHERE id = $1`, [id])).rows[0] || null;

const createAsset = async ({ name, originalName, storageKey, mimeType, sizeBytes, width, height, source = 'upload', parentId = null, userId = null }) => (await pool.query(
  `INSERT INTO email_assets (name, original_name, storage_key, mime_type, size_bytes, width, height, source, parent_id, created_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
   RETURNING ${COLUMNS}`,
  [name, originalName, storageKey, mimeType, sizeBytes || 0, width || null, height || null, source, parentId, userId]
)).rows[0];

const renameAsset = async (id, name) => (await pool.query(
  `UPDATE email_assets SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING ${COLUMNS}`, [name, id]
)).rows[0] || null;

/** Replaces the stored file of an asset in place: every email that uses its URL shows the new picture. */
const replaceAssetFile = async (id, { storageKey, mimeType, sizeBytes, width, height }) => (await pool.query(
  `UPDATE email_assets SET storage_key = $1, mime_type = $2, size_bytes = $3, width = $4, height = $5, updated_at = NOW()
   WHERE id = $6 RETURNING ${COLUMNS}`,
  [storageKey, mimeType, sizeBytes || 0, width || null, height || null, id]
)).rows[0] || null;

const deleteAsset = async (id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [asset] } = await client.query(`DELETE FROM email_assets WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
    // A library entry imported from an old per-campaign upload removes that record too.
    if (asset) {
      const { rows: [legacy] } = await client.query(`SELECT to_regclass('public.newsletter_images') AS t`);
      if (legacy?.t) await client.query('DELETE FROM newsletter_images WHERE storage_key = $1', [asset.storageKey]);
    }
    await client.query('COMMIT');
    return asset || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const storageKeysInLibrary = async (keys) => {
  if (!keys.length) return new Set();
  const { rows } = await pool.query('SELECT storage_key FROM email_assets WHERE storage_key = ANY($1::text[])', [keys]);
  return new Set(rows.map((row) => row.storage_key));
};

const tableExists = async (name) => Boolean((await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t);

/**
 * Everything that can contain an image: campaigns / newsletters, saved templates and automation emails.
 * Content is returned as one searchable string per item.
 */
const listImageContainers = async () => {
  const items = [];
  if (await tableExists('newsletters')) {
    const { rows } = await pool.query(
      `SELECT id, title, status, is_blog, COALESCE(html_content, '') || ' ' || COALESCE(design_json::text, '') || ' ' || COALESCE(image_url, '') AS content
       FROM newsletters`
    );
    rows.forEach((row) => items.push({
      type: row.is_blog ? 'newsletter' : 'campaign', id: row.id, name: row.title || 'Untitled campaign', status: row.status, content: row.content
    }));
  }
  if (await tableExists('newsletter_templates')) {
    const { rows } = await pool.query(
      `SELECT id, name, COALESCE(html_content, '') || ' ' || COALESCE(design_json::text, '') AS content FROM newsletter_templates`
    );
    rows.forEach((row) => items.push({ type: 'template', id: row.id, name: row.name, content: row.content }));
  }
  if (await tableExists('automations')) {
    const { rows } = await pool.query(`SELECT id, name, status, workflow::text AS content FROM automations`);
    rows.forEach((row) => items.push({ type: 'automation', id: row.id, name: row.name, status: row.status, content: row.content }));
  }
  return items;
};

module.exports = { listAssets, findAsset, createAsset, renameAsset, replaceAssetFile, deleteAsset, storageKeysInLibrary, listImageContainers };
