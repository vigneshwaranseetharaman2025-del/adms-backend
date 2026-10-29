const pool = require('../config/db');

// ---------- Conversations ----------

// Finds an existing 1:1 conversation between two users, or null.
const findDirectConversation = async (userIdA, userIdB) => {
  const result = await pool.query(
    `SELECT c.*
     FROM conversations c
     JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
     JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
     WHERE c.type = 'direct'
     LIMIT 1`,
    [userIdA, userIdB]
  );
  return result.rows[0] || null;
};

const createConversation = async ({ type = 'direct', name = null, created_by }) => {
  const result = await pool.query(
    `INSERT INTO conversations (type, name, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [type, name, created_by]
  );
  return result.rows[0];
};

const addParticipant = async (conversationId, userId) => {
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, userId]
  );
};

// Gets or creates the 1:1 conversation between two users.
const getOrCreateDirectConversation = async (userIdA, userIdB) => {
  const existing = await findDirectConversation(userIdA, userIdB);
  if (existing) return existing;

  const conversation = await createConversation({ type: 'direct', created_by: userIdA });
  await addParticipant(conversation.id, userIdA);
  await addParticipant(conversation.id, userIdB);
  return conversation;
};

// Lists all conversations for a user, with the other participant(s), last message, and unread count.
// The last-message/unread calculations respect this user's own clear-chat
// timestamp (cleared_before) — a cleared conversation shows no preview and
// no stale unread count until a new message arrives after the clear.
//
// Direct and group conversations are fetched with separate queries and
// merged in JS. A single query using "the other participant" (as the old
// direct-only version did) produces one duplicated row per member for a
// group — this keeps each shape correct instead of trying to force both
// into one JOIN.
const findConversationsForUser = async (userId) => {
  const directResult = await pool.query(
    `SELECT
        c.id AS conversation_id,
        c.type,
        c.name,
        me.cleared_before,
        other.id AS other_user_id,
        other.username AS other_username,
        other.full_name AS other_full_name,
        other.profile_photo_url AS other_profile_photo_url,
        other.last_seen AS other_last_seen,
        NULL::int AS member_count,
        lm.id AS last_message_id,
        lm.content AS last_message_content,
        lm.message_type AS last_message_type,
        lm.sender_id AS last_message_sender_id,
        lm.status AS last_message_status,
        lm.deleted_at AS last_message_deleted_at,
        lm.created_at AS last_message_at,
        COALESCE(unread.unread_count, 0) AS unread_count
     FROM conversation_participants me
     JOIN conversations c ON c.id = me.conversation_id AND c.type = 'direct'
     LEFT JOIN conversation_participants op ON op.conversation_id = c.id AND op.user_id != me.user_id
     LEFT JOIN users other ON other.id = op.user_id
     LEFT JOIN LATERAL (
        SELECT id, content, message_type, sender_id, status, deleted_at, created_at
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > COALESCE(me.cleared_before, '-infinity'::timestamp)
        ORDER BY m.created_at DESC
        LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
        SELECT COUNT(*) AS unread_count
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != me.user_id
          AND m.status != 'read'
          AND m.created_at > COALESCE(me.cleared_before, '-infinity'::timestamp)
     ) unread ON true
     WHERE me.user_id = $1
       AND lm.id IS NOT NULL`,
    [userId]
  );

  const groupResult = await pool.query(
    `SELECT
        c.id AS conversation_id,
        c.type,
        c.name,
        c.avatar_url AS group_avatar_url,
        me.cleared_before,
        NULL::int AS other_user_id,
        NULL AS other_username,
        NULL AS other_full_name,
        NULL AS other_profile_photo_url,
        NULL::timestamp AS other_last_seen,
        (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id) AS member_count,
        lm.id AS last_message_id,
        lm.content AS last_message_content,
        lm.message_type AS last_message_type,
        lm.sender_id AS last_message_sender_id,
        lm.status AS last_message_status,
        lm.deleted_at AS last_message_deleted_at,
        lm.created_at AS last_message_at,
        COALESCE(unread.unread_count, 0) AS unread_count
     FROM conversation_participants me
     JOIN conversations c ON c.id = me.conversation_id AND c.type = 'group'
     LEFT JOIN LATERAL (
        SELECT id, content, message_type, sender_id, status, deleted_at, created_at
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > COALESCE(me.cleared_before, '-infinity'::timestamp)
        ORDER BY m.created_at DESC
        LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
        SELECT COUNT(*) AS unread_count
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != me.user_id
          AND m.status != 'read'
          AND m.created_at > COALESCE(me.cleared_before, '-infinity'::timestamp)
     ) unread ON true
     WHERE me.user_id = $1`,
    [userId]
  );

  return [...directResult.rows, ...groupResult.rows].sort((a, b) => {
    const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return bt - at;
  });
};

const findConversationById = async (conversationId) => {
  const result = await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  return result.rows[0] || null;
};

const findParticipantIds = async (conversationId) => {
  const result = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [conversationId]
  );
  return result.rows.map((row) => row.user_id);
};

// True for a one-to-one conversation whose other person's account was deleted.
const isDirectWithDeletedUser = async (conversationId) => {
  const result = await pool.query(
    `SELECT c.type, (SELECT COUNT(*)::int FROM conversation_participants cp WHERE cp.conversation_id = c.id) AS members
       FROM conversations c WHERE c.id = $1`,
    [conversationId]
  );
  const row = result.rows[0];
  return Boolean(row && row.type === 'direct' && row.members < 2);
};

const isParticipant = async (conversationId, userId) => {
  const result = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return result.rows.length > 0;
};

// ---------- Groups ----------

// Creates a group conversation and adds the creator (as admin) plus every
// given member id. Returns the conversation row.
const createGroupConversation = async ({ name, createdBy, memberIds = [] }) => {
  const conversation = await createConversation({ type: 'group', name, created_by: createdBy });

  const uniqueMemberIds = Array.from(new Set([createdBy, ...memberIds.map((id) => parseInt(id, 10))]));
  for (const memberId of uniqueMemberIds) {
    await pool.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, is_admin)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversation.id, memberId, memberId === createdBy]
    );
  }
  return conversation;
};

const isGroupAdmin = async (conversationId, userId) => {
  const result = await pool.query(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND is_admin = TRUE`,
    [conversationId, userId]
  );
  return result.rows.length > 0;
};

// Full roster for the group-info screen: every member with their profile
// fields and admin flag.
const getGroupParticipants = async (conversationId) => {
  const result = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.profile_photo_url, u.last_seen, cp.is_admin, cp.joined_at
     FROM conversation_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id = $1
     ORDER BY cp.is_admin DESC, u.full_name NULLS LAST, u.username`,
    [conversationId]
  );
  return result.rows;
};

const addGroupParticipants = async (conversationId, userIds = []) => {
  for (const userId of userIds) {
    await addParticipant(conversationId, parseInt(userId, 10));
  }
  return getGroupParticipants(conversationId);
};

const removeGroupParticipant = async (conversationId, userId) => {
  await pool.query(
    `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
};

const setGroupParticipantAdmin = async (conversationId, userId, isAdmin) => {
  const result = await pool.query(
    `UPDATE conversation_participants SET is_admin = $3
     WHERE conversation_id = $1 AND user_id = $2
     RETURNING *`,
    [conversationId, userId, isAdmin]
  );
  return result.rows[0] || null;
};

// Guards against leaving zero admins behind (a group always needs at least
// one, otherwise nobody could manage it going forward).
const countGroupAdmins = async (conversationId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM conversation_participants WHERE conversation_id = $1 AND is_admin = TRUE`,
    [conversationId]
  );
  return result.rows[0]?.count || 0;
};

const countGroupMembers = async (conversationId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM conversation_participants WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows[0]?.count || 0;
};

const updateGroupDetails = async (conversationId, { name, description, avatarUrl }) => {
  const result = await pool.query(
    `UPDATE conversations
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         avatar_url = COALESCE($4, avatar_url)
     WHERE id = $1
     RETURNING *`,
    [conversationId, name ?? null, description ?? null, avatarUrl ?? null]
  );
  return result.rows[0] || null;
};

// ---------- Messages ----------

const createMessage = async ({
  conversation_id,
  sender_id,
  content,
  message_type = 'text',
  storage_key = null,
  thumbnail_key = null,
  original_filename = null,
  mime_type = null,
  size_bytes = null,
}) => {
  const result = await pool.query(
    `INSERT INTO messages (
        conversation_id, sender_id, content, message_type,
        storage_key, thumbnail_key, original_filename, mime_type, size_bytes, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent')
     RETURNING *`,
    [conversation_id, sender_id, content, message_type, storage_key, thumbnail_key, original_filename, mime_type, size_bytes]
  );
  return result.rows[0];
};

// Cursor-based pagination: pass beforeId (a message id already rendered) to
// fetch the next-older page. Omit it to get the most recent page. Also
// respects the user's own clear-chat cutoff, so cleared history never
// resurfaces via "load more" either.
const findMessages = async ({ conversationId, userId, beforeId = null, pageSize = 30 }) => {
  const resolvedPageSize = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 30));

  const clearedBeforeResult = await pool.query(
    'SELECT cleared_before FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  const clearedBefore = clearedBeforeResult.rows[0]?.cleared_before || null;

  const params = [conversationId, resolvedPageSize];
  let cursorClause = '';
  let clearedClause = '';

  if (beforeId) {
    params.push(beforeId);
    cursorClause = `AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
  }
  if (clearedBefore) {
    params.push(clearedBefore);
    clearedClause = `AND m.created_at > $${params.length}`;
  }

  const result = await pool.query(
    `SELECT * FROM messages m
     WHERE m.conversation_id = $1
     ${cursorClause}
     ${clearedClause}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    params
  );

  const messages = result.rows.reverse(); // oldest-first for rendering
  return { messages, hasMore: result.rows.length === resolvedPageSize };
};

const findMessageById = async (id) => {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
  return result.rows[0] || null;
};

// Called when a user connects (or reconnects): flips every message that was
// sent to them while they were offline from 'sent' -> 'delivered'. Returns
// rows grouped enough for the socket layer to notify each original sender.
const markAllPendingDeliveredForUser = async (userId) => {
  const result = await pool.query(
    `UPDATE messages m
     SET status = 'delivered', delivered_at = NOW()
     FROM conversation_participants me
     WHERE me.conversation_id = m.conversation_id
       AND me.user_id = $1
       AND m.sender_id != $1
       AND m.status = 'sent'
     RETURNING m.id, m.conversation_id, m.sender_id`,
    [userId]
  );
  return result.rows;
};

const editMessage = async (messageId, senderId, newContent) => {
  const result = await pool.query(
    `UPDATE messages SET content = $1, edited_at = NOW()
     WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL AND message_type = 'text'
     RETURNING *`,
    [newContent, messageId, senderId]
  );
  return result.rows[0] || null;
};

// Soft delete ("delete for everyone", WhatsApp-style) — keeps the row as a
// tombstone so the thread still shows "This message was deleted" in place,
// rather than leaving a confusing gap.
const deleteMessage = async (messageId, senderId) => {
  const result = await pool.query(
    `UPDATE messages
     SET deleted_at = NOW(), content = NULL, storage_key = NULL, thumbnail_key = NULL
     WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [messageId, senderId]
  );
  return result.rows[0] || null;
};

// "Clear chat" only affects the requesting user's own view — the other
// participant's history is untouched, matching WhatsApp behaviour.
const clearConversationForUser = async (conversationId, userId) => {
  await pool.query(
    `UPDATE conversation_participants SET cleared_before = NOW()
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
};

const markMessageDelivered = async (messageId) => {
  const result = await pool.query(
    `UPDATE messages SET status = 'delivered', delivered_at = NOW()
     WHERE id = $1 AND status = 'sent'
     RETURNING *`,
    [messageId]
  );
  return result.rows[0] || null;
};

// Marks every unread message sent by someone else in this conversation as read.
const markConversationRead = async (conversationId, readerUserId) => {
  const result = await pool.query(
    `UPDATE messages
     SET status = 'read', read_at = NOW()
     WHERE conversation_id = $1 AND sender_id != $2 AND status != 'read'
     RETURNING id`,
    [conversationId, readerUserId]
  );
  return result.rows.map((row) => row.id);
};

// ---------- Presence ----------

const setUserLastSeen = async (userId) => {
  await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
};

const getUserLastSeen = async (userId) => {
  const result = await pool.query('SELECT last_seen FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.last_seen || null;
};

module.exports = {
  isDirectWithDeletedUser,
  getOrCreateDirectConversation,
  findConversationsForUser,
  findConversationById,
  findParticipantIds,
  isParticipant,
  createGroupConversation,
  isGroupAdmin,
  getGroupParticipants,
  addGroupParticipants,
  removeGroupParticipant,
  setGroupParticipantAdmin,
  countGroupAdmins,
  countGroupMembers,
  updateGroupDetails,
  createMessage,
  findMessages,
  findMessageById,
  editMessage,
  deleteMessage,
  clearConversationForUser,
  markAllPendingDeliveredForUser,
  markMessageDelivered,
  markConversationRead,
  setUserLastSeen,
  getUserLastSeen,
};