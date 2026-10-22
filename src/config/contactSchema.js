const pool = require('./db');

/**
 * Custom contact fields and per-contact details (field values, tags, notes).
 * Details are keyed by email address, so they work the same for organisation members
 * (users table) and contacts added by hand or imported (newsletter_contacts).
 */
const initContactSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_fields (
      id SERIAL PRIMARY KEY,
      key VARCHAR(40) NOT NULL UNIQUE,
      label VARCHAR(80) NOT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'number', 'date', 'select', 'boolean')),
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      description VARCHAR(255),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_attributes (
      email VARCHAR(320) PRIMARY KEY,
      field_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      tags TEXT[] NOT NULL DEFAULT '{}',
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contact_attributes_tags ON contact_attributes USING GIN (tags);`);
};

module.exports = initContactSchema;
