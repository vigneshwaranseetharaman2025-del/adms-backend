const bcrypt = require('bcryptjs');
const pool = require('./db');

/**
 * Access levels, manager links and safe user deletion. Runs on every start and is
 * idempotent: it only adds columns, triggers and indexes, and changes how a few
 * foreign keys behave when a user is deleted. Nothing is dropped.
 *
 *  - users.access_level ('superadmin' | 'admin' | 'user'). On the first run, existing
 *    administrators (is_admin) become Admin and the default admin account becomes
 *    Superadmin. users.is_admin is kept in step by a trigger, so code that still reads
 *    is_admin keeps working.
 *  - A trigger refuses any change that would leave no Superadmin.
 *  - users.manager_id links a user to their manager (users.manager keeps the name for
 *    older code). Filled once from the existing manager names where the name matches
 *    exactly one user.
 *  - Foreign keys: shared content (documents, photos, conversations, call history) keeps
 *    existing when its uploader / creator / caller is deleted; the user's own rows
 *    (chat membership, own messages, call participation) are removed with the user.
 */

const columnExists = async (client, table, column) => {
  const { rows } = await client.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [table, column]
  );
  return rows.length > 0;
};

const tableExists = async (client, table) => {
  const { rows } = await client.query('SELECT to_regclass($1) AS t', [table]);
  return Boolean(rows[0]?.t);
};

/** Makes the foreign key on table.column → users(id) use the given ON DELETE action. */
const ensureUserForeignKey = async (client, table, column, action) => {
  if (!(await tableExists(client, table)) || !(await columnExists(client, table, column))) return;
  const wanted = { 'SET NULL': 'n', CASCADE: 'c' }[action];
  const { rows } = await client.query(
    `SELECT c.conname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = 'users'::regclass
        AND a.attname = $2 AND array_length(c.conkey, 1) = 1`,
    [table, column]
  );
  if (rows.length === 1 && rows[0].confdeltype === wanted) return;
  for (const row of rows) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${row.conname}"`);
  if (action === 'SET NULL') await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
  // NOT VALID skips the full-table check (existing rows already satisfy the old key);
  // VALIDATE then checks it without blocking writes for long.
  const name = `${table}_${column}_fkey`;
  await client.query(`ALTER TABLE ${table} ADD CONSTRAINT "${name}" FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE ${action} NOT VALID`);
  await client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT "${name}"`);
};

const ensureSuperadmin = async (client) => {
  const { rows: [{ count }] } = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'");
  if (count > 0) return;

  const defaultUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const promoted = await client.query(
    `UPDATE users SET access_level = 'superadmin'
      WHERE id = (SELECT id FROM users WHERE username = $1
                  UNION ALL
                  (SELECT id FROM users WHERE is_admin = TRUE ORDER BY id LIMIT 1)
                  LIMIT 1)
      RETURNING username`,
    [defaultUsername]
  );
  if (promoted.rows[0]) {
    console.log(`[rbac] ${promoted.rows[0].username} is the Superadmin.`);
    return;
  }

  // Empty database: create the default administrator so someone can sign in.
  const hashedPassword = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123', 10);
  await client.query(
    `INSERT INTO users (username, password, full_name, email, access_level, is_admin, role)
     VALUES ($1, $2, 'Admin User', $3, 'superadmin', TRUE, 'user')`,
    [defaultUsername, hashedPassword, process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com']
  );
  console.log(`Created default admin: ${defaultUsername}`);
};

const initRbacSchema = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One server at a time runs this migration.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('adms_rbac_schema'))");

    const firstRun = !(await columnExists(client, 'users', 'access_level'));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_level VARCHAR(20) NOT NULL DEFAULT 'user'`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_access_level_check') THEN
          ALTER TABLE users ADD CONSTRAINT users_access_level_check CHECK (access_level IN ('superadmin', 'admin', 'user'));
        END IF;
      END $$;`);
    if (firstRun) {
      await client.query(`UPDATE users SET access_level = 'admin' WHERE is_admin = TRUE`);
      await client.query(`UPDATE users SET access_level = 'superadmin' WHERE username = $1 AND is_admin = TRUE`, [process.env.DEFAULT_ADMIN_USERNAME || 'admin']);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_access_level ON users(access_level)`);

    // is_admin always follows access_level. Older code that only flips is_admin still works:
    // true makes a regular user an Admin, false makes anyone a regular User.
    await client.query(`
      CREATE OR REPLACE FUNCTION adms_users_access_sync() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF COALESCE(NEW.access_level, 'user') = 'user' AND NEW.is_admin THEN
            NEW.access_level := 'admin';
          END IF;
        ELSIF NEW.access_level IS NOT DISTINCT FROM OLD.access_level AND NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
          IF NEW.is_admin THEN
            IF OLD.access_level = 'user' THEN NEW.access_level := 'admin'; END IF;
          ELSE
            NEW.access_level := 'user';
          END IF;
        END IF;
        NEW.access_level := COALESCE(NEW.access_level, 'user');
        NEW.is_admin := NEW.access_level IN ('admin', 'superadmin');
        RETURN NEW;
      END $$ LANGUAGE plpgsql;`);
    await client.query(`DROP TRIGGER IF EXISTS trg_users_access_sync ON users`);
    await client.query(`CREATE TRIGGER trg_users_access_sync BEFORE INSERT OR UPDATE OF access_level, is_admin ON users
                        FOR EACH ROW EXECUTE FUNCTION adms_users_access_sync()`);

    // Never leave the system without a Superadmin, whichever code path tries.
    await client.query(`
      CREATE OR REPLACE FUNCTION adms_users_keep_superadmin() RETURNS trigger AS $$
      BEGIN
        IF OLD.access_level = 'superadmin'
           AND (TG_OP = 'DELETE' OR NEW.access_level <> 'superadmin')
           AND NOT EXISTS (SELECT 1 FROM users WHERE access_level = 'superadmin') THEN
          RAISE EXCEPTION 'ADMS_LAST_SUPERADMIN' USING HINT = 'At least one Superadmin must remain.';
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql;`);
    await client.query(`DROP TRIGGER IF EXISTS trg_users_keep_superadmin ON users`);
    await client.query(`CREATE TRIGGER trg_users_keep_superadmin AFTER UPDATE OF access_level OR DELETE ON users
                        FOR EACH ROW EXECUTE FUNCTION adms_users_keep_superadmin()`);

    // Manager as a real link to another user.
    const managerIdIsNew = !(await columnExists(client, 'users', 'manager_id'));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER`);
    await ensureUserForeignKey(client, 'users', 'manager_id', 'SET NULL');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users(manager_id)`);
    if (managerIdIsNew) {
      const { rowCount } = await client.query(`
        UPDATE users u SET manager_id = match.manager_id
          FROM (
            SELECT u2.id AS user_id, MIN(m.id) AS manager_id
              FROM users u2
              JOIN users m ON m.id <> u2.id
               AND LOWER(TRIM(u2.manager)) IN (LOWER(TRIM(COALESCE(m.full_name, ''))), LOWER(TRIM(m.username)))
             WHERE u2.manager IS NOT NULL AND TRIM(u2.manager) <> ''
             GROUP BY u2.id
            HAVING COUNT(DISTINCT m.id) = 1
          ) match
         WHERE u.id = match.user_id`);
      if (rowCount) console.log(`[rbac] Linked ${rowCount} user(s) to their manager.`);
    }

    // What happens to other tables when a user is deleted.
    await ensureUserForeignKey(client, 'documents', 'uploaded_by', 'SET NULL');
    await ensureUserForeignKey(client, 'gallery_photos', 'uploaded_by', 'SET NULL');
    await ensureUserForeignKey(client, 'conversations', 'created_by', 'SET NULL');
    await ensureUserForeignKey(client, 'conversation_participants', 'user_id', 'CASCADE');
    await ensureUserForeignKey(client, 'messages', 'sender_id', 'CASCADE');
    await ensureUserForeignKey(client, 'calls', 'caller_id', 'SET NULL');
    await ensureUserForeignKey(client, 'call_participants', 'user_id', 'CASCADE');
    await ensureUserForeignKey(client, 'events', 'created_by', 'SET NULL'); // dashboard calendar, when present

    await ensureSuperadmin(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

module.exports = initRbacSchema;
