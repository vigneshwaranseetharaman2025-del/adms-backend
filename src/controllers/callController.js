const callModel = require('../models/callModel');

// GET /api/chat/calls?limit=&beforeId=
// Returns this user's call history (individual + group), newest first,
// shaped for the "Calls" tab in the sidebar.
const getCallHistory = async (req, res, next) => {
  try {
    const { limit, beforeId } = req.query;
    const rows = await callModel.getCallHistoryForUser(req.user.id, {
      limit: limit ? Math.min(100, parseInt(limit, 10) || 50) : 50,
      beforeId: beforeId ? parseInt(beforeId, 10) : null,
    });

    const calls = rows.map((row) => ({
      callId: row.call_id,
      conversationId: row.conversation_id,
      callType: row.call_type,
      isGroup: row.is_group,
      status: row.status, // ringing | ongoing | ended | missed | rejected
      direction: String(row.caller_id) === String(req.user.id) ? 'outgoing' : 'incoming',
      startedAt: row.started_at,
      answeredAt: row.answered_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds,
      groupName: row.is_group ? row.conversation_name : null,
      otherUser: row.other_user_id
        ? {
            id: row.other_user_id,
            username: row.other_username,
            fullName: row.other_full_name,
            profilePhotoUrl: row.other_profile_photo_url,
          }
        : null,
    }));

    res.json({ calls, hasMore: rows.length === (limit ? parseInt(limit, 10) : 50) });
  } catch (error) {
    next(error);
  }
};

const deleteCallHistoryItem = async (req, res, next) => {
  try {
    const callId = Number(req.params.callId);
    if (!callId) {
      return res.status(400).json({ message: 'A valid call id is required.' });
    }

    const deletedCount = await callModel.deleteCallForUser(req.user.id, callId);
    return res.json({ deleted: deletedCount > 0, callId, deletedCount });
  } catch (error) {
    return next(error);
  }
};

const clearCallHistory = async (req, res, next) => {
  try {
    const deletedCount = await callModel.clearCallHistoryForUser(req.user.id);
    return res.json({ deleted: deletedCount > 0, deletedCount });
  } catch (error) {
    return next(error);
  }
};

module.exports = { getCallHistory, deleteCallHistoryItem, clearCallHistory };
