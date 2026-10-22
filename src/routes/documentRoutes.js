const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  uploadDocument,
  uploadMultipleDocuments,
  getAllDocuments,
  getDocumentById,
  updateDocumentDetails,
  updateDocumentsDetails,
  getDocumentThumbnail,
  downloadDocument,
  deleteDocument,
  deleteDocuments,
  createDocumentFolder,
  renameDocumentFolder,
  deleteDocumentFolder,
  getDocumentFolders,
  acknowledgeDocument,
  getDocumentAcknowledgements,
  getDocumentPermissions,
  updateDocumentPermission,
} = require('../controllers/documentController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || `${50 * 1024 * 1024}`, 10) },
});

const router = express.Router();

router.get('/', authenticateToken, getAllDocuments);
router.get('/folders', authenticateToken, getDocumentFolders);
router.post('/folders', authenticateToken, createDocumentFolder);
router.patch('/folders/:folderKey', authenticateToken, renameDocumentFolder);
router.delete('/folders/:folderKey', authenticateToken, deleteDocumentFolder);
router.get('/:id', authenticateToken, getDocumentById);
router.post('/:id/acknowledge', authenticateToken, acknowledgeDocument);
router.get('/:id/acknowledgements', authenticateToken, getDocumentAcknowledgements);
router.get('/:id/permissions', authenticateToken, getDocumentPermissions);
router.put('/:id/permissions/:userId', authenticateToken, updateDocumentPermission);
router.patch('/bulk', authenticateToken, updateDocumentsDetails);
router.patch('/:id', authenticateToken, updateDocumentDetails);
router.post('/upload', authenticateToken, upload.single('file'), uploadDocument);
router.post('/upload-many', authenticateToken, upload.any(), uploadMultipleDocuments);
router.get('/:id/thumbnail', authenticateToken, getDocumentThumbnail);
router.get('/:id/download', authenticateToken, downloadDocument);
router.delete('/bulk', authenticateToken, deleteDocuments);
router.delete('/:id', authenticateToken, deleteDocument);

module.exports = router;
