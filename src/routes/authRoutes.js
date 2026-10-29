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
  usersSummary,
  managerOptions,
  getUser,
  updateUser,
  updateAccessLevel,
  userDeletionImpact,
  deleteUser,
  updateAdminStatus,
  listRoles,
  getRolePermissions,
  saveRolePermissions,
  updateRole,
} = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireCapability } = require('../middleware/requireCapability');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_PROFILE_PHOTO_BYTES || `${5 * 1024 * 1024}`, 10) },
});

const router = express.Router();

router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(400).json({ message: 'Invalid user id.' })));

router.post('/login', login);
router.post('/register', authenticateToken, requireCapability('users.create'), register);
router.post('/refresh-token', refreshToken);
router.post('/logout', authenticateToken, logout);
router.post('/change-password', authenticateToken, changePassword);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.post('/profile/photo', authenticateToken, upload.single('file'), uploadProfilePhoto);
// Users and roles. Every route checks the caller's capability (config/accessPolicy.js);
// handlers add the finer rules (e.g. only a Superadmin may change a Superadmin).
router.get('/users', authenticateToken, requireCapability('users.view'), listUsers);
router.get('/users/summary', authenticateToken, requireCapability('users.view'), usersSummary);
router.get('/users/managers', authenticateToken, requireCapability('users.view'), managerOptions);
router.get('/users/:id', authenticateToken, requireCapability('users.view'), getUser);
router.patch('/users/:id', authenticateToken, requireCapability('users.edit'), updateUser);
router.patch('/users/:id/access', authenticateToken, requireCapability('users.grant_admin'), updateAccessLevel);
router.patch('/users/:id/admin', authenticateToken, requireCapability('users.grant_admin'), updateAdminStatus);
router.patch('/users/:id/role', authenticateToken, requireCapability('users.edit'), updateRole);
router.get('/users/:id/deletion-impact', authenticateToken, requireCapability('users.delete'), userDeletionImpact);
router.delete('/users/:id', authenticateToken, requireCapability('users.delete'), deleteUser);
router.get('/roles', authenticateToken, requireCapability('admin.access'), listRoles);
router.get('/roles/:role/permissions', authenticateToken, requireCapability('admin.access'), getRolePermissions);
router.put('/roles/:role/permissions', authenticateToken, requireCapability('roles.manage'), saveRolePermissions);
router.post('/request-password-reset', requestPasswordReset);
router.post('/reset-password', resetPassword);

module.exports = router;
