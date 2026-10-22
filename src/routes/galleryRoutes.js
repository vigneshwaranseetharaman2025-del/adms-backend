const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  uploadGalleryItem,
  uploadMultipleGalleryItems,
  getGalleryItems,
  getGalleryItemById,
  getGalleryItemComments,
  addGalleryItemComment,
  removeGalleryItemComment,
  updateGalleryItemDetails,
  updateGalleryItemsDetails,
  getGalleryItemThumbnail,
  downloadGalleryItem,
  deleteGalleryItem,
  deleteGalleryItems,
  createGalleryFolderHandler,
  getGalleryFolders,
  updateGalleryFolderEventDateHandler,
  updateGalleryFolderMetadataHandler,
  renameGalleryFolderHandler,
  deleteGalleryFolderHandler,
} = require('../controllers/galleryController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || `${50 * 1024 * 1024}`, 10) },
});

const router = express.Router();

router.get('/', authenticateToken, getGalleryItems);
router.get('/folders', authenticateToken, getGalleryFolders);
router.post('/folders', authenticateToken, createGalleryFolderHandler);
router.patch('/folders/:folderKey', authenticateToken, renameGalleryFolderHandler);
router.patch('/folders/:folderKey/event-date', authenticateToken, updateGalleryFolderEventDateHandler);
router.patch('/folders/:folderKey/metadata', authenticateToken, updateGalleryFolderMetadataHandler);
router.delete('/folders/:folderKey', authenticateToken, deleteGalleryFolderHandler);
router.get('/:id/comments', authenticateToken, getGalleryItemComments);
router.post('/:id/comments', authenticateToken, addGalleryItemComment);
router.delete('/:id/comments/:commentId', authenticateToken, removeGalleryItemComment);
router.get('/:id', authenticateToken, getGalleryItemById);
router.patch('/bulk', authenticateToken, updateGalleryItemsDetails);
router.patch('/:id', authenticateToken, updateGalleryItemDetails);
router.post('/upload', authenticateToken, upload.single('file'), uploadGalleryItem);
router.post('/upload-many', authenticateToken, upload.any(), uploadMultipleGalleryItems);
router.get('/:id/thumbnail', authenticateToken, getGalleryItemThumbnail);
router.get('/:id/download', authenticateToken, downloadGalleryItem);
router.delete('/bulk', authenticateToken, deleteGalleryItems);
router.delete('/:id', authenticateToken, deleteGalleryItem);

module.exports = router;
