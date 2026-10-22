const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const controller = require('../controllers/emailAssetController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 30 } });
// Campaign role permissions: reading needs "Campaigns: view", changes need "Campaigns: edit & send".
const { byMethod } = require('../middleware/campaignAccess');
// Turns multer's size errors into a readable message instead of a 500.
const withUpload = (handler) => (req, res, next) => handler(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'Each image must be 10 MB or smaller.' });
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: 'Upload at most 30 images at a time.' });
  next(error);
});

// Public, read-only: pictures inside sent emails load without signing in.
router.get('/:id/file', controller.file);

router.use(authenticateToken, byMethod);
router.get('/', controller.list);
router.post('/', withUpload(upload.array('images', 30)), controller.upload);
router.post('/import-url', express.json(), controller.importUrl);
router.post('/bulk-delete', express.json(), controller.bulkRemove);
router.get('/:id', controller.getOne);
router.patch('/:id', express.json(), controller.rename);
router.put('/:id/file', withUpload(upload.single('image')), controller.replace);
router.delete('/:id', controller.remove);

module.exports = router;
