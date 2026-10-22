const pool = require('./db');

/**
 * Shared image library for campaigns, newsletters, templates and automation emails.
 * Images live here independently of any one campaign, so deleting a draft never
 * breaks a template or another campaign that reuses the same picture.
 */
const initEmailAssetSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_assets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      original_name VARCHAR(255),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      source VARCHAR(30) NOT NULL DEFAULT 'upload',
      parent_id INTEGER REFERENCES email_assets(id) ON DELETE SET NULL,
      legacy_url TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_assets_created ON email_assets(created_at DESC);`);

  // One-time, idempotent import of images that were uploaded per campaign before the library
  // existed. They keep their old URL (legacy_url), so emails that already use them keep working.
  const { rows: [legacy] } = await pool.query(`SELECT to_regclass('public.newsletter_images') AS t`);
  if (legacy?.t) {
    await pool.query(`
      INSERT INTO email_assets (name, original_name, storage_key, mime_type, source, legacy_url, created_at)
      SELECT COALESCE(NULLIF(regexp_replace(ni.original_name, '\\.[^.]+$', ''), ''), 'Campaign image'),
             ni.original_name, ni.storage_key, COALESCE(ni.mime_type, 'image/jpeg'), 'campaign', ni.image_url, COALESCE(ni.created_at, NOW())
      FROM newsletter_images ni
      WHERE ni.storage_key IS NOT NULL
      ON CONFLICT (storage_key) DO NOTHING;
    `);
  }
};

module.exports = initEmailAssetSchema;
