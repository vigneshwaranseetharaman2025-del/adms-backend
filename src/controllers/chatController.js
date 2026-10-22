const crypto = require('crypto');
const sharp = require('sharp');
const storage = require('../storage');
const chatModel = require('../models/chatModel');
const { findUserById, findAllUsersExcept } = require('../models/userModel');

const buildKey = (prefix, originalName) => {
  const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const hash = crypto.randomUUID();
  const dateSegment = new Date().toISOString().slice(0, 10);
  return `chat/${prefix}/${dateSegment}/${hash}${ext}`;
};

const isImageMimeType = (mimeType) => typeof mimeType === 'string' && mimeType.startsWith('image/');
const isVideoMimeType = (mimeType) => typeof mimeType === 'string' && mimeType.startsWith('video/');

const mediaTypeFromKey = (key) => {
  const extension = key.split('?')[0].split('.').pop()?.toLowerCase();
  const types = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return types[extension] || 'application/octet-stream';
};

// Group participant rows come back from the DB in snake_case; the rest of
// this API is camelCase, so normalize before sending to the client.
const mapParticipant = (p) => ({
  id: p.id,
  username: p.username,
  fullName: p.full_name,
  profilePhotoUrl: p.profile_photo_url,
  lastSeen: p.last_seen,
  isAdmin: p.is_admin,
  joinedAt: p.joined_at,
});

// GET /api/chat/conversations
const getConversations = async (req, res, next) => {
  try {
    const rows = await chatModel.findConversationsForUser(req.user.id);
    const conversations = rows.map((row) => ({
      conversationId: row.conversation_id,
      type: row.type,
      name: row.name,
      avatarUrl: row.group_avatar_url || null,
      memberCount: row.member_count != null ? parseInt(row.member_count, 10) : null,
      otherUser: row.other_user_id
        ? {
            id: row.other_user_id,
            username: row.other_username,
            fullName: row.other_full_name,
            profilePhotoUrl: row.other_profile_photo_url,
            lastSeen: row.other_last_seen,
          }
        : null,
      lastMessage: row.last_message_id
        ? {
            id: row.last_message_id,
            content: row.last_message_content,
            type: row.last_message_type,
            senderId: row.last_message_sender_id,
            status: row.last_message_status,
            createdAt: row.last_message_at,
          }
        : null,
      unreadCount: parseInt(row.unread_count, 10) || 0,
    }));
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/users — directory for starting a new conversation
const getChatUsers = async (req, res, next) => {
  try {
    const users = await findAllUsersExcept(req.user.id);
    res.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        fullName: u.full_name,
        department: u.department,
        role: u.role,
        profilePhotoUrl: u.profile_photo_url,
        lastSeen: u.last_seen,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/conversations/direct  { userId }
const openDirectConversation = async (req, res, next) => {
  try {
    const otherUserId = parseInt(req.body.userId, 10);
    if (!otherUserId || otherUserId === req.user.id) {
      return res.status(400).json({ message: 'A valid target userId is required.' });
    }

    const otherUser = await findUserById(otherUserId);
    if (!otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const conversation = await chatModel.getOrCreateDirectConversation(req.user.id, otherUserId);
    res.status(200).json({ conversationId: conversation.id, type: conversation.type });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/groups  { name, memberIds: [] }
const createGroup = async (req, res, next) => {
  try {
    const { name, memberIds = [] } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Group name is required.' });
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ message: 'At least one member is required to create a group.' });
    }

    const conversation = await chatModel.createGroupConversation({
      name: name.trim(),
      createdBy: req.user.id,
      memberIds,
    });
    const participants = await chatModel.getGroupParticipants(conversation.id);
    res.status(201).json({
      conversationId: conversation.id,
      type: 'group',
      name: conversation.name,
      participants: participants.map(mapParticipant),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/groups/:id — group-info screen data
const getGroupInfo = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const allowed = await chatModel.isParticipant(conversationId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'You are not part of this group.' });
    }
    const conversation = await chatModel.findConversationById(conversationId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ message: 'Group not found.' });
    }
    const participants = await chatModel.getGroupParticipants(conversationId);
    res.json({
      conversationId,
      name: conversation.name,
      description: conversation.description,
      avatarUrl: conversation.avatar_url,
      memberCount: participants.length,
      participants: participants.map(mapParticipant),
      isAdmin: participants.some((p) => p.id === req.user.id && p.is_admin),
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/chat/groups/:id  { name, description }
const updateGroup = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const isAdmin = await chatModel.isGroupAdmin(conversationId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ message: 'Only group admins can edit group details.' });
    }
    const { name, description } = req.body || {};
    const updated = await chatModel.updateGroupDetails(conversationId, { name, description });
    res.json({ conversationId, name: updated.name, description: updated.description });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/groups/:id/participants  { userIds: [] } — admin only
const addGroupParticipants = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const isAdmin = await chatModel.isGroupAdmin(conversationId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ message: 'Only group admins can add participants.' });
    }
    const { userIds = [] } = req.body || {};
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'userIds is required.' });
    }
    const participants = await chatModel.addGroupParticipants(conversationId, userIds);
    const mapped = participants.map(mapParticipant);
    req.app.get('io')?.emitToConversation?.(conversationId, 'group:participants-updated', { conversationId, participants: mapped });
    res.json({ conversationId, participants: mapped });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/chat/groups/:id/participants/:userId — admin only (or self, to leave)
const removeGroupParticipant = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const isSelf = targetUserId === req.user.id;
    const isAdmin = await chatModel.isGroupAdmin(conversationId, req.user.id);

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ message: 'Only group admins can remove other participants.' });
    }

    // Don't allow the last admin to leave/be removed while other members remain —
    // the group would be left unmanageable.
    const targetIsAdmin = await chatModel.isGroupAdmin(conversationId, targetUserId);
    if (targetIsAdmin) {
      const adminCount = await chatModel.countGroupAdmins(conversationId);
      const memberCount = await chatModel.countGroupMembers(conversationId);
      if (adminCount <= 1 && memberCount > 1) {
        return res.status(400).json({
          message: 'Assign another admin before removing the last admin from a group with other members.',
        });
      }
    }

    await chatModel.removeGroupParticipant(conversationId, targetUserId);
    const participants = await chatModel.getGroupParticipants(conversationId);
    const mapped = participants.map(mapParticipant);
    req.app.get('io')?.emitToConversation?.(conversationId, 'group:participants-updated', { conversationId, participants: mapped });
    res.json({ conversationId, participants: mapped, removedUserId: targetUserId, left: isSelf });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/chat/groups/:id/admins/:userId  { isAdmin: true|false } — admin only
const setGroupParticipantAdmin = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const isAdmin = await chatModel.isGroupAdmin(conversationId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ message: 'Only group admins can assign/remove admins.' });
    }
    const { isAdmin: makeAdmin } = req.body || {};

    if (makeAdmin === false) {
      const adminCount = await chatModel.countGroupAdmins(conversationId);
      if (adminCount <= 1) {
        return res.status(400).json({ message: 'A group must have at least one admin.' });
      }
    }

    await chatModel.setGroupParticipantAdmin(conversationId, targetUserId, Boolean(makeAdmin));
    const participants = await chatModel.getGroupParticipants(conversationId);
    const mapped = participants.map(mapParticipant);
    req.app.get('io')?.emitToConversation?.(conversationId, 'group:participants-updated', { conversationId, participants: mapped });
    res.json({ conversationId, participants: mapped });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/conversations/:id/messages?beforeId=&pageSize=
const getMessages = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const allowed = await chatModel.isParticipant(conversationId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'You are not part of this conversation.' });
    }

    const { beforeId, pageSize } = req.query;
    const { messages, hasMore } = await chatModel.findMessages({
      conversationId,
      userId: req.user.id,
      beforeId: beforeId ? parseInt(beforeId, 10) : null,
      pageSize,
    });
    res.json({ conversationId, messages, hasMore });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/conversations/:id/clear — clears history for this user only
const clearConversation = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const allowed = await chatModel.isParticipant(conversationId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'You are not part of this conversation.' });
    }
    await chatModel.clearConversationForUser(conversationId, req.user.id);
    res.json({ conversationId, cleared: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/conversations/:id/read
// Marks all inbound messages as read; the caller should also emit this over
// the socket (see chatSocket.js) so the sender's tick updates live. This REST
// endpoint exists so read state is correct even after a page refresh.
const markConversationRead = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const allowed = await chatModel.isParticipant(conversationId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'You are not part of this conversation.' });
    }
    const readIds = await chatModel.markConversationRead(conversationId, req.user.id);
    res.json({ conversationId, readMessageIds: readIds });
  } catch (error) {
    next(error);
  }
};

// POST /api/chat/conversations/:id/media  (multipart 'file')
// Uploads an image/video/document for a chat message and returns the keys
// to send along with the socket 'message:send' event. Mirrors
// documentController's upload + thumbnail flow so it reuses the same
// storage provider and uploads/ layout (just under a chat/ prefix).
const uploadChatMedia = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const allowed = await chatModel.isParticipant(conversationId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'You are not part of this conversation.' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'File is required.' });
    }

    const mimeType = file.mimetype;
    let messageType = 'document';
    if (isImageMimeType(mimeType)) messageType = 'image';
    else if (isVideoMimeType(mimeType)) messageType = 'video';
    else if (mimeType?.startsWith('audio/')) messageType = 'audio';

    const storageKey = buildKey(
      messageType === 'image' ? 'photos' : messageType === 'video' ? 'videos' : 'docs',
      file.originalname
    );
    await storage.upload(storageKey, file.buffer, mimeType);

    let thumbnailKey = null;
    if (isImageMimeType(mimeType)) {
      thumbnailKey = buildKey('thumbnails', file.originalname);
      const thumbnailBuffer = await sharp(file.buffer)
        .resize(300, 300, { fit: 'cover', position: sharp.strategy.entropy })
        .webp({ quality: 80 })
        .toBuffer();
      await storage.upload(thumbnailKey, thumbnailBuffer, 'image/webp');
    }
    // Video thumbnails need ffmpeg (not currently a dependency); the client
    // falls back to a video-file icon/poster until that's added.

    res.status(201).json({
      messageType,
      storageKey,
      thumbnailKey,
      originalFilename: file.originalname,
      mimeType,
      sizeBytes: file.size,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/chat/media?key=chat/photos/2026-08-10/uuid.jpg
// Query param instead of a path wildcard on purpose — Express 5 (path-to-regexp v8)
// changed wildcard syntax, so a plain query string sidesteps that entirely.
const streamChatMedia = async (req, res, next) => {
  try {
    const key = req.query.key;
    if (!key || !/^(chat|documents|gallery)\//.test(key)) {
      return res.status(400).json({ message: 'Invalid media key.' });
    }

    if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
      const stream = storage.getStream(key);
      res.setHeader('Content-Type', mediaTypeFromKey(key));
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      stream.on('error', () => res.status(404).json({ message: 'File not found.' }));
      stream.pipe(res);
      return;
    }

    const url = await storage.getUrl(key);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getChatUsers,
  getConversations,
  openDirectConversation,
  createGroup,
  getGroupInfo,
  updateGroup,
  addGroupParticipants,
  removeGroupParticipant,
  setGroupParticipantAdmin,
  getMessages,
  clearConversation,
  markConversationRead,
  uploadChatMedia,
  streamChatMedia,
};