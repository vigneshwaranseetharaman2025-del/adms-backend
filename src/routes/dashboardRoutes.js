const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
	getQuickActions, getRecentActivity, addFavorite, removeFavorite, clearAllFavorites,
	clearDownload, clearAllDownloads, clearShared, clearAllShared, getEvents, createEvent, updateEvent, deleteEvent,
	getDashboardSummary,
} = require('../controllers/dashboardController');

const router = express.Router();
router.get('/summary', authenticateToken, getDashboardSummary);
router.get('/quick-actions', authenticateToken, getQuickActions);
router.get('/recent-activity', authenticateToken, getRecentActivity);
router.get('/events', authenticateToken, getEvents);
router.post('/events', authenticateToken, createEvent);
router.put('/events/:id', authenticateToken, updateEvent);
router.delete('/events/:id', authenticateToken, deleteEvent);
router.post('/favorites', authenticateToken, addFavorite);
router.delete('/favorites/:itemType/:itemId', authenticateToken, removeFavorite);
router.delete('/favorites', authenticateToken, clearAllFavorites);
router.delete('/downloads/:itemType/:itemId', authenticateToken, clearDownload);
router.delete('/downloads', authenticateToken, clearAllDownloads);
router.delete('/shared/:messageId', authenticateToken, clearShared);
router.delete('/shared', authenticateToken, clearAllShared);
module.exports = router;