const pool = require('../config/db');

// Creates a call row plus a call_participants row for the caller (already
// 'joined') and one per callee (starting 'ringing'). Works for both a 1:1
// call (one calleeId) and a group call (many calleeIds).
const createCall = async ({ conversationId, callerId, calleeIds = [], callType = 'audio', isGroup = false }) => {
  const callResult = await pool.query(
    `INSERT INTO calls (conversation_id, caller_id, call_type, is_group, status, started_at)
     VALUES ($1, $2, $3, $4, 'ringing', NOW())
     RETURNING *`,
    [conversationId, callerId, callType, isGroup]
  );
  const call = callResult.rows[0];

  await pool.query(
    `INSERT INTO call_participants (call_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'caller', 'joined', NOW())`,
    [call.id, callerId]
  );

  for (const calleeId of calleeIds) {
    await pool.query(
      `INSERT INTO call_participants (call_id, user_id, role, status)
       VALUES ($1, $2, 'callee', 'ringing')
       ON CONFLICT (call_id, user_id) DO NOTHING`,
      [call.id, calleeId]
    );
  }

  return call;
};

const getCallById = async (callId) => {
  const result = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
  return result.rows[0] || null;
};

// Finds the most recent still-ringing/ongoing call for a 1:1 conversation —
// used to correlate a bare 'call:answer'/'call:reject'/'call:end' socket
// event (which only carries the other user's id) back to its DB row.
const getActiveCallForConversation = async (conversationId) => {
  const result = await pool.query(
    `SELECT * FROM calls
     WHERE conversation_id = $1 AND status IN ('ringing', 'ongoing')
     ORDER BY started_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
};

// First answer of any callee flips the whole call to 'ongoing'.
const markParticipantJoined = async (callId, userId) => {
  await pool.query(
    `UPDATE call_participants SET status = 'joined', joined_at = NOW()
     WHERE call_id = $1 AND user_id = $2`,
    [callId, userId]
  );
  const call = await getCallById(callId);
  if (call && !call.answered_at) {
    await pool.query(
      `UPDATE calls SET status = 'ongoing', answered_at = NOW() WHERE id = $1`,
      [callId]
    );
  }
  return getCallById(callId);
};

const markParticipantRejected = async (callId, userId) => {
  await pool.query(
    `UPDATE call_participants SET status = 'rejected' WHERE call_id = $1 AND user_id = $2`,
    [callId, userId]
  );
};

const markParticipantLeft = async (callId, userId) => {
  await pool.query(
    `UPDATE call_participants SET status = 'left', left_at = NOW()
     WHERE call_id = $1 AND user_id = $2 AND status = 'joined'`,
    [callId, userId]
  );
};

const countActiveParticipants = async (callId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
    [callId]
  );
  return result.rows[0]?.count || 0;
};

const listActiveParticipantIds = async (callId) => {
  const result = await pool.query(
    `SELECT user_id FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
    [callId]
  );
  return result.rows.map((r) => r.user_id);
};

// Ends/finalizes a call: computes duration (0 if never answered) and picks
// a terminal status. `reason` lets the caller force 'rejected' explicitly
// (declined before anyone else joined) instead of the generic 'missed'.
const finalizeCall = async (callId, { reason } = {}) => {
  const call = await getCallById(callId);
  if (!call) return null;
  if (['ended', 'missed', 'rejected'].includes(call.status)) return call; // already finalized

  let status;
  let durationSeconds = 0;
  if (call.answered_at) {
    status = 'ended';
    durationSeconds = Math.max(0, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000));
  } else {
    status = reason === 'rejected' ? 'rejected' : 'missed';
  }

  const result = await pool.query(
    `UPDATE calls SET status = $2, ended_at = NOW(), duration_seconds = $3 WHERE id = $1 RETURNING *`,
    [callId, status, durationSeconds]
  );
  return result.rows[0];
};

// Call history for a user: every call (direct or group) they were a
// participant in, newest first, with enough info to render a Teams-style
// call-history row (who/what group, direction, status, duration).
const getCallHistoryForUser = async (userId, { limit = 50, beforeId = null } = {}) => {
  const params = [userId, limit];
  let cursorClause = '';
  if (beforeId) {
    params.push(beforeId);
    cursorClause = `AND c.id < $${params.length}`;
  }

  const result = await pool.query(
    `SELECT
        c.id AS call_id,
        c.conversation_id,
        c.caller_id,
        c.call_type,
        c.is_group,
        c.status,
        c.started_at,
        c.answered_at,
        c.ended_at,
        c.duration_seconds,
        conv.type AS conversation_type,
        conv.name AS conversation_name,
        me.status AS my_status,
        other.id AS other_user_id,
        other.username AS other_username,
        other.full_name AS other_full_name,
        other.profile_photo_url AS other_profile_photo_url
     FROM call_participants me
     JOIN calls c ON c.id = me.call_id
     JOIN conversations conv ON conv.id = c.conversation_id
     LEFT JOIN LATERAL (
        SELECT u.id, u.username, u.full_name, u.profile_photo_url
        FROM call_participants cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.call_id = c.id AND cp.user_id != me.user_id AND c.is_group = FALSE
        LIMIT 1
     ) other ON true
     WHERE me.user_id = $1
     ${cursorClause}
     ORDER BY c.id DESC
     LIMIT $2`,
    params
  );
  return result.rows;
};

const deleteCallForUser = async (userId, callId) => {
  const { rowCount } = await pool.query(
    `DELETE FROM call_participants
     WHERE user_id = $1 AND call_id = $2`,
    [userId, callId]
  );

  if (rowCount === 0) {
    return 0;
  }

  await pool.query(
    `DELETE FROM calls c
     WHERE c.id = $1
       AND NOT EXISTS (
         SELECT 1 FROM call_participants cp WHERE cp.call_id = c.id
       )`,
    [callId]
  );

  return rowCount;
};

const clearCallHistoryForUser = async (userId) => {
  const callIdsResult = await pool.query(
    `SELECT DISTINCT call_id FROM call_participants WHERE user_id = $1`,
    [userId]
  );

  const callIds = callIdsResult.rows.map((row) => row.call_id);
  if (!callIds.length) {
    return 0;
  }

  await pool.query(`DELETE FROM call_participants WHERE user_id = $1`, [userId]);

  await pool.query(
    `DELETE FROM calls c
     WHERE c.id = ANY($1)
       AND NOT EXISTS (
         SELECT 1 FROM call_participants cp WHERE cp.call_id = c.id
       )`,
    [callIds]
  );

  return callIds.length;
};

module.exports = {
  createCall,
  getCallById,
  getActiveCallForConversation,
  markParticipantJoined,
  markParticipantRejected,
  markParticipantLeft,
  countActiveParticipants,
  listActiveParticipantIds,
  finalizeCall,
  getCallHistoryForUser,
  deleteCallForUser,
  clearCallHistoryForUser,
};
