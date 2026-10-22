const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
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
} = require('../controllers/chatController');
const { getCallHistory, deleteCallHistoryItem, clearCallHistory } = require('../controllers/callController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_CHAT_UPLOAD_BYTES || `${100 * 1024 * 1024}`, 10) },
});

const router = express.Router();

router.get('/users', authenticateToken, getChatUsers);
router.get('/conversations', authenticateToken, getConversations);
router.post('/conversations/direct', authenticateToken, openDirectConversation);
router.get('/conversations/:id/messages', authenticateToken, getMessages);
router.post('/conversations/:id/clear', authenticateToken, clearConversation);
router.post('/conversations/:id/read', authenticateToken, markConversationRead);
router.post('/conversations/:id/media', authenticateToken, upload.single('file'), uploadChatMedia);

// --- Groups ---
router.post('/groups', authenticateToken, createGroup);
router.get('/groups/:id', authenticateToken, getGroupInfo);
router.patch('/groups/:id', authenticateToken, updateGroup);
router.post('/groups/:id/participants', authenticateToken, addGroupParticipants);
router.delete('/groups/:id/participants/:userId', authenticateToken, removeGroupParticipant);
router.patch('/groups/:id/admins/:userId', authenticateToken, setGroupParticipantAdmin);

// --- Calls ---
router.get('/calls', authenticateToken, getCallHistory);
router.delete('/calls/:callId', authenticateToken, deleteCallHistoryItem);
router.delete('/calls', authenticateToken, clearCallHistory);

// Key passed as a query param (?key=chat/photos/...) rather than a path
// wildcard, since Express 5's path-to-regexp v8 reworked wildcard syntax.
router.get('/media', authenticateToken, streamChatMedia);

module.exports = router;
