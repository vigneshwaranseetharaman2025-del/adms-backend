const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireCapability } = require('../middleware/requireCapability');
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
// Viewing and downloading: everyone signed in (within their permissions).
// Creating, editing, moving and deleting: Admins and Superadmins only.
const canManage = requireCapability('gallery.manage');

router.get('/', authenticateToken, getGalleryItems);
router.get('/folders', authenticateToken, getGalleryFolders);
router.post('/folders', authenticateToken, canManage, createGalleryFolderHandler);
router.patch('/folders/:folderKey', authenticateToken, canManage, renameGalleryFolderHandler);
router.patch('/folders/:folderKey/event-date', authenticateToken, canManage, updateGalleryFolderEventDateHandler);
router.patch('/folders/:folderKey/metadata', authenticateToken, canManage, updateGalleryFolderMetadataHandler);
router.delete('/folders/:folderKey', authenticateToken, canManage, deleteGalleryFolderHandler);
router.get('/:id/comments', authenticateToken, getGalleryItemComments);
router.post('/:id/comments', authenticateToken, addGalleryItemComment);
router.delete('/:id/comments/:commentId', authenticateToken, removeGalleryItemComment);
router.get('/:id', authenticateToken, getGalleryItemById);
router.patch('/bulk', authenticateToken, canManage, updateGalleryItemsDetails);
router.patch('/:id', authenticateToken, canManage, updateGalleryItemDetails);
router.post('/upload', authenticateToken, canManage, upload.single('file'), uploadGalleryItem);
router.post('/upload-many', authenticateToken, canManage, upload.any(), uploadMultipleGalleryItems);
router.get('/:id/thumbnail', authenticateToken, getGalleryItemThumbnail);
router.get('/:id/download', authenticateToken, downloadGalleryItem);
router.delete('/bulk', authenticateToken, canManage, deleteGalleryItems);
router.delete('/:id', authenticateToken, canManage, deleteGalleryItem);

module.exports = router;
