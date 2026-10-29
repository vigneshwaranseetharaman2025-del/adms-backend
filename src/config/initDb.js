const pool = require('./db');
const initAutomationSchema = require('./automationSchema');
const initEmailAssetSchema = require('./emailAssetSchema');
const initContactSchema = require('./contactSchema');
const initCampaignSchema = require('./campaignSchema');
const initRbacSchema = require('./rbacSchema');

const createTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        full_name VARCHAR(200),
        email VARCHAR(200),
        phone_number VARCHAR(50),
        department VARCHAR(200),
        role VARCHAR(200),
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        location VARCHAR(200),
        manager VARCHAR(200),
        employee_id VARCHAR(100),
        join_date DATE,
        bio TEXT,
        profile_photo_url VARCHAR(1024),
        reset_token TEXT,
        reset_token_expires TIMESTAMP,
        refresh_token TEXT,
        refresh_token_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(200);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(200);`);
    await pool.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';`);
    await pool.query(`UPDATE users SET role = 'user' WHERE role IS NULL OR TRIM(role) = '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(200);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager VARCHAR(200);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(100);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS join_date DATE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url VARCHAR(1024);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role VARCHAR(100) PRIMARY KEY,
        view BOOLEAN NOT NULL DEFAULT TRUE,
        download BOOLEAN NOT NULL DEFAULT TRUE,
        upload BOOLEAN NOT NULL DEFAULT FALSE,
        edit BOOLEAN NOT NULL DEFAULT FALSE,
        delete_permission BOOLEAN NOT NULL DEFAULT FALSE,
        share BOOLEAN NOT NULL DEFAULT TRUE,
        copy BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      INSERT INTO role_permissions (role, view, download, share)
      VALUES ('user', TRUE, TRUE, TRUE)
      ON CONFLICT (role) DO NOTHING;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        original_filename VARCHAR(255),
        mime_type VARCHAR(100),
        size_bytes BIGINT,
        storage_key VARCHAR(1024),
        thumbnail_key VARCHAR(1024),
        folder_id VARCHAR(255),
        checksum VARCHAR(128),
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS size_bytes BIGINT;`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key VARCHAR(1024);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS thumbnail_key VARCHAR(1024);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id VARCHAR(255);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS checksum VARCHAR(128);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS author VARCHAR(200);`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS acknowledgement_required BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('document', 'gallery')),
        item_id INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, item_type, item_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS download_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('document', 'gallery')),
        item_id INTEGER NOT NULL,
        downloaded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_download_history_user ON download_history(user_id, downloaded_at DESC);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS document_permissions (
        id SERIAL PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        view BOOLEAN NOT NULL DEFAULT TRUE,
        download BOOLEAN NOT NULL DEFAULT FALSE,
        upload BOOLEAN NOT NULL DEFAULT FALSE,
        edit BOOLEAN NOT NULL DEFAULT FALSE,
        delete_permission BOOLEAN NOT NULL DEFAULT FALSE,
        share BOOLEAN NOT NULL DEFAULT FALSE,
        copy BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(document_id, user_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS document_acknowledgements (
        id SERIAL PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        signed_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(document_id, user_id)
      );
    `);
    await pool.query(`ALTER TABLE document_acknowledgements ADD COLUMN IF NOT EXISTS signature_data TEXT;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS folders (
        id SERIAL PRIMARY KEY,
        folder_key VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        parent_folder_key VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_folder_key VARCHAR(255);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_folders (
        id SERIAL PRIMARY KEY,
        folder_key VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        parent_folder_key VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE gallery_folders ADD COLUMN IF NOT EXISTS parent_folder_key VARCHAR(255);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_photos (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        original_filename VARCHAR(255),
        mime_type VARCHAR(100),
        size_bytes BIGINT,
        storage_key VARCHAR(1024),
        thumbnail_key VARCHAR(1024),
        folder_id VARCHAR(255),
        checksum VARCHAR(128),
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS size_bytes BIGINT;`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS storage_key VARCHAR(1024);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS thumbnail_key VARCHAR(1024);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS folder_id VARCHAR(255);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS checksum VARCHAR(128);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS author VARCHAR(200);`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();`);
    await pool.query(`ALTER TABLE gallery_photos ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_comments (
        id SERIAL PRIMARY KEY,
        gallery_item_id INTEGER NOT NULL REFERENCES gallery_photos(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        comment TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_comments_item ON gallery_comments(gallery_item_id, created_at ASC);`);

    // ---------- Chat ----------
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL DEFAULT 'direct',
        name VARCHAR(255),
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(conversation_id, user_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT,
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        storage_key VARCHAR(1024),
        thumbnail_key VARCHAR(1024),
        original_filename VARCHAR(255),
        mime_type VARCHAR(100),
        size_bytes BIGINT,
        status VARCHAR(20) NOT NULL DEFAULT 'sent',
        delivered_at TIMESTAMP,
        read_at TIMESTAMP,
        edited_at TIMESTAMP,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversation_participants_user_id ON conversation_participants(user_id);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_shared_hidden (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        hidden_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, message_id)
      );
    `);

    // Per-user "clear chat" — clearing only hides history for the user who
    // cleared it, not for the other participant.
    await pool.query(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS cleared_before TIMESTAMP;`);

    // ---------- Groups ----------
    // Admin flag per participant row — a conversation can have multiple
    // admins. The creator is granted admin automatically (see groupModel).
    await pool.query(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Optional per-group avatar/description; harmless for direct chats.
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(1024);`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description TEXT;`);

    // ---------- Calls (individual + group) ----------
    // A bare CREATE TABLE IF NOT EXISTS silently no-ops if a `calls` table
    // already exists from an earlier partial run — leaving it stuck without
    // whatever columns were added since. Every column gets an explicit
    // ALTER ... ADD COLUMN IF NOT EXISTS below (same defensive pattern the
    // users/documents tables above already use) so an existing-but-stale
    // table gets healed on the next server start instead of throwing
    // "column does not exist" forever.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        caller_id INTEGER NOT NULL REFERENCES users(id)
      );
    `);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_type VARCHAR(10) NOT NULL DEFAULT 'audio';`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ringing';`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS started_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS answered_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_participants (
        id SERIAL PRIMARY KEY,
        call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id)
      );
    `);
    await pool.query(`ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS role VARCHAR(10) NOT NULL DEFAULT 'callee';`);
    await pool.query(`ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ringing';`);
    await pool.query(`ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS left_at TIMESTAMP;`);
    // Unique constraint can't use ADD COLUMN IF NOT EXISTS — guard it separately.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'call_participants_call_id_user_id_key'
        ) THEN
          ALTER TABLE call_participants ADD CONSTRAINT call_participants_call_id_user_id_key UNIQUE (call_id, user_id);
        END IF;
      END $$;
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_calls_conversation_id ON calls(conversation_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_participants_call_id ON call_participants(call_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_participants_user_id ON call_participants(user_id);`);

    await initAutomationSchema();
    await initEmailAssetSchema();
    await initContactSchema();
    await initCampaignSchema();
    // Access levels, manager links, delete behaviour of user foreign keys, and the
    // default administrator (created only when no Superadmin exists).
    await initRbacSchema();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS newsletter_sender_domains (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(253) NOT NULL UNIQUE,
        verification_token VARCHAR(128) NOT NULL,
        dkim_selector VARCHAR(64) NOT NULL,
        dkim_public_key TEXT NOT NULL,
        dkim_private_key_encrypted TEXT NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE newsletter_sender_domains ADD COLUMN IF NOT EXISTS dkim_private_key_encrypted TEXT;`);
    // Older versions of this table had a NOT NULL "dkim_private_key" column; keys are now stored in dkim_private_key_encrypted.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'newsletter_sender_domains' AND column_name = 'dkim_private_key'
        ) THEN
          ALTER TABLE newsletter_sender_domains ALTER COLUMN dkim_private_key DROP NOT NULL;
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE newsletter_sender_domains ADD COLUMN IF NOT EXISTS spf_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE newsletter_sender_domains ADD COLUMN IF NOT EXISTS dkim_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE newsletter_sender_domains ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;`);
    await pool.query(`UPDATE newsletter_sender_domains SET spf_verified = TRUE, dkim_verified = TRUE WHERE verified = TRUE;`);

    console.log('Database tables created or confirmed.');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
};

module.exports = createTables;