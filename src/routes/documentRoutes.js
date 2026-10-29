const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireCapability } = require('../middleware/requireCapability');
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
// Viewing and downloading: everyone signed in (within their permissions).
// Creating, editing, moving and deleting: Admins and Superadmins only.
const canManage = requireCapability('documents.manage');

router.get('/', authenticateToken, getAllDocuments);
router.get('/folders', authenticateToken, getDocumentFolders);
router.post('/folders', authenticateToken, canManage, createDocumentFolder);
router.patch('/folders/:folderKey', authenticateToken, canManage, renameDocumentFolder);
router.delete('/folders/:folderKey', authenticateToken, canManage, deleteDocumentFolder);
router.get('/:id', authenticateToken, getDocumentById);
router.post('/:id/acknowledge', authenticateToken, acknowledgeDocument);
router.get('/:id/acknowledgements', authenticateToken, canManage, getDocumentAcknowledgements);
router.get('/:id/permissions', authenticateToken, canManage, getDocumentPermissions);
router.put('/:id/permissions/:userId', authenticateToken, canManage, updateDocumentPermission);
router.patch('/bulk', authenticateToken, canManage, updateDocumentsDetails);
router.patch('/:id', authenticateToken, canManage, updateDocumentDetails);
router.post('/upload', authenticateToken, canManage, upload.single('file'), uploadDocument);
router.post('/upload-many', authenticateToken, canManage, upload.any(), uploadMultipleDocuments);
router.get('/:id/thumbnail', authenticateToken, getDocumentThumbnail);
router.get('/:id/download', authenticateToken, downloadDocument);
router.delete('/bulk', authenticateToken, canManage, deleteDocuments);
router.delete('/:id', authenticateToken, canManage, deleteDocument);

module.exports = router;
