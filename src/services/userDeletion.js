const pool = require('../config/db');
const storage = require('../storage');

/**
 * Permanently deletes a user and their personal data in one transaction.
 *
 * Removed (the user's own data):
 *   account row and refresh token; chat messages they sent and the files attached to them;
 *   their chat memberships and call participation; favorites, download history,
 *   document acknowledgements, per-document permissions, photo comments, hidden dashboard
 *   items; their automation enrollments; their profile photo file.
 *
 * Kept (shared data and other people's records):
 *   documents and photos they uploaded (organisation content, uploader shown as removed),
 *   campaigns, templates, contacts and send history (creator fields cleared),
 *   conversations with others and everyone else's messages, call history of others,
 *   the people who reported to them (manager link cleared).
 *
 * Rules: only a Superadmin may call this (checked by the route), never on themselves,
 * never on the last Superadmin. Files are deleted only after the transaction commits,
 * so a failed delete never leaves the database half-done.
 */

class UserDeletionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Integer user references without a foreign key. They only record who created or
// changed shared records, so they are cleared, never used to delete anything.
const ATTRIBUTION_COLUMNS = [
  ['newsletters', 'created_by'],
  ['newsletters', 'updated_by'],
  ['newsletter_sends', 'initiated_by'],
  ['newsletter_sends', 'paused_by'],
  ['newsletter_sends', 'cancelled_by'],
  ['newsletter_templates', 'created_by'],
  ['newsletter_groups', 'created_by'],
  ['newsletter_contacts', 'created_by'],
  ['email_assets', 'created_by'],
];

const existingColumns = async (db) => {
  const { rows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (table_name, column_name) IN (${ATTRIBUTION_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`,
    ATTRIBUTION_COLUMNS.flat()
  );
  return rows.map((row) => [row.table_name, row.column_name]);
};

const tableExists = async (db, table) => Boolean((await db.query('SELECT to_regclass($1) AS t', [table])).rows[0].t);

/** Storage key of a profile photo URL produced by uploadProfilePhoto, or null. */
const profilePhotoKey = (url) => {
  const match = String(url || '').split('?')[0].match(/(profile-photos\/[^\s]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const count = async (db, sql, params) => Number((await db.query(sql, params)).rows[0]?.n || 0);

/** What deleting this user would remove and keep. Used by the confirmation dialog. */
const getDeletionImpact = async (userId, db = pool) => {
  const id = parseInt(userId, 10);
  const { rows: [user] } = await db.query(
    'SELECT id, username, full_name, email, access_level, profile_photo_url FROM users WHERE id = $1',
    [id]
  );
  if (!user) return null;
  const hasEnrollments = await tableExists(db, 'automation_enrollments');
  const hasNewsletters = await tableExists(db, 'newsletters');
  // Run one after another: `db` may be a single transaction client.
  const counts = [];
  for (const pending of [
    () => count(db, 'SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1 AND (storage_key IS NOT NULL OR thumbnail_key IS NOT NULL)', [id]),
    () => count(db, `SELECT COUNT(*) AS n FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id WHERE cp.user_id = $1 AND c.type = 'direct'`, [id]),
    () => count(db, `SELECT COUNT(*) AS n FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id WHERE cp.user_id = $1 AND c.type = 'group'`, [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM call_participants WHERE user_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM download_history WHERE user_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM document_acknowledgements WHERE user_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM document_permissions WHERE user_id = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM gallery_comments WHERE user_id = $1', [id]),
    () => (hasEnrollments ? count(db, 'SELECT COUNT(*) AS n FROM automation_enrollments WHERE user_id = $1', [id]) : 0),
    () => count(db, 'SELECT COUNT(*) AS n FROM documents WHERE uploaded_by = $1', [id]),
    () => count(db, 'SELECT COUNT(*) AS n FROM gallery_photos WHERE uploaded_by = $1', [id]),
    () => (hasNewsletters ? count(db, 'SELECT COUNT(*) AS n FROM newsletters WHERE created_by = $1', [id]) : 0),
    () => count(db, 'SELECT COUNT(*) AS n FROM users WHERE manager_id = $1', [id]),
  ]) counts.push(await pending());
  const [
    messages, attachments, directChats, groupChats, calls, favorites, downloads, acknowledgements,
    documentPermissions, comments, enrollments, documents, photos, campaigns, reports,
  ] = counts;
  return {
    user: { id: user.id, username: user.username, name: user.full_name || user.username, email: user.email, accessLevel: user.access_level },
    removed: {
      messages, attachments, directChats, groupChats, calls, favorites, downloads,
      acknowledgements, documentPermissions, comments, automationEnrollments: enrollments,
      profilePhoto: Boolean(profilePhotoKey(user.profile_photo_url)),
    },
    kept: { documents, photos, campaigns, directReports: reports },
  };
};

/**
 * Deletes the user. `actor` is req.user. Returns { impact, filesDeleted, filesFailed }.
 * Throws UserDeletionError for rule violations.
 */
const deleteUserAccount = async ({ actor, targetId, io = null }) => {
  const id = parseInt(targetId, 10);
  if (!Number.isFinite(id)) throw new UserDeletionError(400, 'INVALID_ID', 'Invalid user id.');
  if (String(actor?.id) === String(id)) {
    throw new UserDeletionError(400, 'SELF_DELETE', 'You cannot delete your own account.');
  }

  const client = await pool.connect();
  let impact;
  let fileKeys = [];
  try {
    await client.query('BEGIN');
    const { rows: [target] } = await client.query(
      'SELECT id, email, access_level, profile_photo_url FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!target) throw new UserDeletionError(404, 'NOT_FOUND', 'User not found.');

    if (target.access_level === 'superadmin') {
      // Lock every Superadmin row so two deletions cannot both pass this check.
      const { rows } = await client.query("SELECT id FROM users WHERE access_level = 'superadmin' ORDER BY id FOR UPDATE");
      if (rows.length <= 1) {
        throw new UserDeletionError(409, 'LAST_SUPERADMIN', 'This is the only Superadmin. Make someone else Superadmin first.');
      }
    }

    impact = await getDeletionImpact(id, client);

    // Files the user owns: chat attachments they sent and their profile photo.
    const { rows: files } = await client.query(
      `SELECT storage_key AS key FROM messages WHERE sender_id = $1 AND storage_key IS NOT NULL
       UNION SELECT thumbnail_key FROM messages WHERE sender_id = $1 AND thumbnail_key IS NOT NULL`,
      [id]
    );
    fileKeys = files.map((row) => row.key);
    const photoKey = profilePhotoKey(target.profile_photo_url);
    if (photoKey) fileKeys.push(photoKey);

    // Groups the user is in, before their membership is removed.
    const { rows: memberships } = await client.query(
      `SELECT cp.conversation_id, c.type FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id WHERE cp.user_id = $1`,
      [id]
    );

    // Chat: their own messages and memberships.
    await client.query('DELETE FROM messages WHERE sender_id = $1', [id]);
    await client.query('DELETE FROM conversation_participants WHERE user_id = $1', [id]);
    for (const { conversation_id: conversationId, type } of memberships) {
      const { rows: [left] } = await client.query(
        'SELECT COUNT(*)::int AS members, COUNT(*) FILTER (WHERE is_admin)::int AS admins FROM conversation_participants WHERE conversation_id = $1',
        [conversationId]
      );
      if (left.members === 0) {
        // Nobody is left to read it.
        await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      } else if (type === 'group' && left.admins === 0) {
        // Keep the group manageable: the longest-standing member becomes its admin.
        await client.query(
          `UPDATE conversation_participants SET is_admin = TRUE
            WHERE id = (SELECT id FROM conversation_participants WHERE conversation_id = $1 ORDER BY joined_at ASC NULLS LAST, id ASC LIMIT 1)`,
          [conversationId]
        );
      }
    }
    await client.query('DELETE FROM call_participants WHERE user_id = $1', [id]);
    await client.query('UPDATE calls SET caller_id = NULL WHERE caller_id = $1', [id]);
    await client.query('UPDATE conversations SET created_by = NULL WHERE created_by = $1', [id]);

    // Activity and per-user records (these also cascade; deleted explicitly so the
    // result does not depend on how an older database defined its keys).
    await client.query('DELETE FROM user_favorites WHERE user_id = $1', [id]);
    await client.query('DELETE FROM download_history WHERE user_id = $1', [id]);
    await client.query('DELETE FROM document_acknowledgements WHERE user_id = $1', [id]);
    await client.query('DELETE FROM document_permissions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM gallery_comments WHERE user_id = $1', [id]);
    await client.query('DELETE FROM dashboard_shared_hidden WHERE user_id = $1', [id]);
    if (await tableExists(client, 'automation_enrollments')) {
      await client.query('DELETE FROM automation_enrollments WHERE user_id = $1', [id]);
    }

    // Shared content stays; only the link to the deleted person is cleared.
    await client.query('UPDATE documents SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
    await client.query('UPDATE gallery_photos SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
    await client.query('UPDATE users SET manager_id = NULL, manager = NULL WHERE manager_id = $1', [id]);
    if (await tableExists(client, 'automations')) await client.query('UPDATE automations SET created_by = NULL WHERE created_by = $1', [id]);
    if (await tableExists(client, 'scheduled_emails')) await client.query('UPDATE scheduled_emails SET created_by = NULL WHERE created_by = $1', [id]);
    for (const [table, column] of await existingColumns(client)) {
      await client.query(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = $1`, [id]);
    }

    // Any other table that points at users without an ON DELETE rule (for example a table
    // added outside this code base): clear nullable references so they do not block the delete.
    // A NOT NULL reference makes the delete fail and the whole transaction is rolled back.
    const { rows: otherRefs } = await client.query(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, a.attnotnull AS not_null
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND c.confdeltype IN ('a', 'r')
          AND array_length(c.conkey, 1) = 1`
    );
    for (const ref of otherRefs) {
      if (ref.not_null) continue;
      await client.query(`UPDATE ${ref.tbl} SET "${ref.col}" = NULL WHERE "${ref.col}" = $1`, [id]);
    }

    await client.query('DELETE FROM users WHERE id = $1', [id]);

    // A file still used elsewhere is not deleted: a document or photo shared in chat
    // carries the document's own storage key, and attachments can be forwarded.
    if (fileKeys.length) {
      const { rows: stillUsed } = await client.query(
        `SELECT storage_key AS key FROM messages WHERE storage_key = ANY($1)
         UNION SELECT thumbnail_key FROM messages WHERE thumbnail_key = ANY($1)
         UNION SELECT storage_key FROM documents WHERE storage_key = ANY($1)
         UNION SELECT thumbnail_key FROM documents WHERE thumbnail_key = ANY($1)
         UNION SELECT storage_key FROM gallery_photos WHERE storage_key = ANY($1)
         UNION SELECT thumbnail_key FROM gallery_photos WHERE thumbnail_key = ANY($1)
         UNION SELECT k FROM unnest($1::text[]) k WHERE EXISTS (SELECT 1 FROM users WHERE profile_photo_url LIKE '%' || k)`,
        [fileKeys]
      );
      const used = new Set(stillUsed.map((row) => row.key));
      fileKeys = fileKeys.filter((key) => !used.has(key));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof UserDeletionError) throw error;
    if (String(error.message).includes('ADMS_LAST_SUPERADMIN')) {
      throw new UserDeletionError(409, 'LAST_SUPERADMIN', 'This is the only Superadmin. Make someone else Superadmin first.');
    }
    if (error.code === '23503') {
      // Foreign key violation: another table still requires this user. Nothing was deleted.
      throw new UserDeletionError(409, 'DEPENDENCY', `The user could not be deleted because ${error.table || 'another table'} still refers to them. Nothing was deleted.`);
    }
    throw error;
  } finally {
    client.release();
  }

  // After commit: end live sessions and remove the user's files.
  try {
    io?.in(`user:${id}`).disconnectSockets(true);
  } catch (error) {
    console.error('[user-delete] could not disconnect sockets:', error.message);
  }
  const results = await Promise.allSettled(fileKeys.map((key) => storage.delete(key)));
  const filesFailed = results
    .map((result, index) => (result.status === 'rejected' && result.reason?.code !== 'ENOENT' ? fileKeys[index] : null))
    .filter(Boolean);
  if (filesFailed.length) console.error(`[user-delete] ${filesFailed.length} file(s) for user ${id} could not be deleted:`, filesFailed);

  return { impact, filesDeleted: fileKeys.length - filesFailed.length, filesFailed: filesFailed.length };
};

module.exports = { getDeletionImpact, deleteUserAccount, UserDeletionError, profilePhotoKey };
