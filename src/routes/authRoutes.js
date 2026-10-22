const express = require('express');
const multer = require('multer');
const {
  login,
  register,
  changePassword,
  requestPasswordReset,
  resetPassword,
  refreshToken,
  logout,
  getProfile,
  updateProfile,
  uploadProfilePhoto,
  listUsers,
  updateAdminStatus,
  listRoles,
  getRolePermissions,
  saveRolePermissions,
  updateRole,
} = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_PROFILE_PHOTO_BYTES || `${5 * 1024 * 1024}`, 10) },
});

const router = express.Router();

router.post('/login', login);
router.post('/register', authenticateToken, register);
router.post('/refresh-token', refreshToken);
router.post('/logout', authenticateToken, logout);
router.post('/change-password', authenticateToken, changePassword);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.post('/profile/photo', authenticateToken, upload.single('file'), uploadProfilePhoto);
router.get('/users', authenticateToken, listUsers);
router.patch('/users/:id/admin', authenticateToken, updateAdminStatus);
router.patch('/users/:id/role', authenticateToken, updateRole);
router.get('/roles', authenticateToken, listRoles);
router.get('/roles/:role/permissions', authenticateToken, getRolePermissions);
router.put('/roles/:role/permissions', authenticateToken, saveRolePermissions);
router.post('/request-password-reset', requestPasswordReset);
router.post('/reset-password', resetPassword);

module.exports = router;
