const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const storage = require('../storage');
const {
  findUserByUsername,
  findUserByEmail,
  findUserById,
  createUser,
  updateUserPassword,
  getUserProfile,
  updateUserProfile,
  setPasswordResetToken,
  findUserByResetToken,
  findUserByRefreshToken,
  setRefreshToken,
  clearRefreshToken,
  findAllUsers,
  updateUserAdminStatus,
  findRoles,
  findRolePermissions,
  updateRolePermissions,
  updateUserRole,
  searchUsers,
  getUserSummary,
  findManagerOptions,
  findManagerIdByName,
  setUserAccessLevel,
} = require('../models/userModel');
const pool = require('../config/db');
const {
  LEVELS,
  LEVEL_LABELS,
  normalizeLevel,
  can,
  capabilitiesFor,
  capabilityLabelsFor,
  accessChangeError,
  canEditUser,
} = require('../config/accessPolicy');
const { getDeletionImpact, deleteUserAccount, UserDeletionError } = require('../services/userDeletion');
const { markUserActivated } = require('../models/userModel');
const { emitAutomationEvent } = require('../services/automation/triggers');

const SALT_ROUNDS = 12;
const PASSWORD_SECRET = process.env.PASSWORD_ENCRYPTION_SECRET || 'Aithent@Jikan123';
const PASSWORD_IV = process.env.PASSWORD_ENCRYPTION_IV || 'RandomInitVector';
const REFRESH_TOKEN_EXPIRES_MS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_MS || '604800000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// Shared SMTP transport: picks the right TLS mode for SMTP_PORT (see config/mailer.js).
const { mailer: transporter } = require('../config/mailer');

const sendResetPasswordEmail = async (to, token) => {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const html = `
    <p>You requested a password reset for ADMS.</p>
    <p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#0047ab;color:#ffffff;border-radius:6px;text-decoration:none;">Reset Password</a></p>
    <p>If the button does not work, copy and paste this link into your browser:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
  `;

  await transporter.sendMail({
    from: SMTP_USERNAME,
    to,
    bcc: ADMIN_EMAIL,
    subject: 'ADMS Password Reset',
    html,
  });
};

const decryptPassword = (encrypted) => {
  if (!encrypted) return null;
  try {
    const key = crypto.createHash('sha256').update(PASSWORD_SECRET).digest();
    const iv = Buffer.from(PASSWORD_IV, 'utf8');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    return null;
  }
};

// Resolve password: attempt to decrypt the 'password' field (client sends encrypted string),
// otherwise try 'encryptedPassword' field, otherwise return raw password string.
const resolvePassword = (rawPassword, encryptedPassword) => {
  // If rawPassword looks like base64 (likely encrypted), try to decrypt it first
  if (rawPassword) {
    const maybe = decryptPassword(rawPassword);
    if (maybe) return maybe;
    return rawPassword; // treat as plain text
  }

  if (encryptedPassword) {
    const maybe = decryptPassword(encryptedPassword);
    if (maybe) return maybe;
  }

  return null;
};

const buildTokens = async (user) => {
  const accessToken = jwt.sign(
    { id: user.id, username: user.username, is_admin: Boolean(user.is_admin) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  );

  const refreshToken = crypto.randomBytes(64).toString('hex');
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS);
  await setRefreshToken(user.id, refreshToken, refreshExpiresAt);

  return { accessToken, refreshToken };
};

/**
 * The signed-in user as the client sees it: profile fields plus access level,
 * capabilities (what the menus and buttons may show) and the effective permissions.
 * Built from accessPolicy and role_permissions, the same rules the API enforces.
 */
const buildSessionUser = async (userId) => {
  const profile = await getUserProfile(userId);
  if (!profile) return null;
  const level = normalizeLevel(profile.access_level);
  const isManager = can(level, 'documents.manage');
  const rolePermissions = await findRolePermissions(String(profile.role || '').trim() || 'user');
  const documentAccess = {
    view: isManager || rolePermissions.view !== false,
    download: isManager || rolePermissions.download !== false,
    share: isManager || rolePermissions.share === true,
    upload: isManager,
    edit: isManager,
    delete: isManager,
  };
  const permissions = capabilityLabelsFor(level);
  if (!isManager) {
    // Role permissions can narrow what a regular user may open; say so on the profile.
    if (!documentAccess.view) permissions.push('Documents: only those shared with you');
    if (!documentAccess.download) permissions.push('Downloads are turned off for your role');
  }
  return {
    ...profile,
    access_level: level,
    access_level_label: LEVEL_LABELS[level],
    is_admin: can(level, 'admin.access'),
    capabilities: capabilitiesFor(level),
    document_access: documentAccess,
    permissions,
  };
};

/** A user row for Administration: public fields, access label and what the caller may do. */
const presentUser = (actor, user) => ({ ...user, access_level_label: LEVEL_LABELS[normalizeLevel(user.access_level)], actions: actionsFor(actor, user) });

/** Per-row actions the signed-in user may take on a user in the Administration list. */
const actionsFor = (actor, target) => {
  const self = String(actor.id) === String(target.id);
  const editable = canEditUser(actor.access_level, target.access_level);
  return {
    canEdit: editable,
    canChangeAccess: editable && !self && can(actor.access_level, 'users.grant_admin'),
    canGrantSuperadmin: can(actor.access_level, 'users.grant_superadmin'),
    canDelete: can(actor.access_level, 'users.delete') && !self,
    isSelf: self,
  };
};

const login = async (req, res, next) => {
  try {
    const { username, password, encryptedPassword } = req.body;
    const decryptedPassword = resolvePassword(password, encryptedPassword);

    console.debug('authController.login payload', { username, hasEncrypted: !!encryptedPassword });
    console.debug('decryptedPassword preview', decryptedPassword ? `${decryptedPassword.slice(0, 2)}... length ${decryptedPassword.length}` : null);

    if (!username || !decryptedPassword) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const isValidPassword = await bcrypt.compare(decryptedPassword, user.password);
    console.debug('authController.login compare result', { userId: user.id, isValidPassword });
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const { accessToken, refreshToken } = await buildTokens(user);

    // First successful sign-in = account activated (drives the "User Activated" automation trigger).
    markUserActivated(user.id)
      .then((activated) => activated?.email && emitAutomationEvent('user_activated', { email: activated.email, userId: activated.id, eventKey: `user:${activated.id}` }))
      .catch((error) => console.error('[automation] activation hook failed:', error.message));

    res.json({
      accessToken,
      refreshToken,
      user: await buildSessionUser(user.id),
    });
  } catch (error) {
    next(error);
  }
};

const register = async (req, res, next) => {
  try {
    if (!can(req.user?.access_level, 'users.create')) {
      return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const { username, password, encryptedPassword, full_name, email, phone_number, department, role, location, manager, employee_id, join_date } = req.body;
    const decryptedPassword = resolvePassword(password, encryptedPassword);

    if (!username || !decryptedPassword) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const accessLevel = req.body.access_level ? String(req.body.access_level).toLowerCase() : 'user';
    const accessError = accessChangeError({ actorId: req.user.id, actorLevel: req.user.access_level, targetId: null, fromLevel: 'user', toLevel: accessLevel });
    if (accessError) return res.status(403).json({ message: accessError });

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists.' });
    }

    let managerId = req.body.manager_id ? parseInt(req.body.manager_id, 10) : null;
    if (!managerId && manager) managerId = await findManagerIdByName(manager, 0);

    const hashedPassword = await bcrypt.hash(decryptedPassword, SALT_ROUNDS);
    const newUser = await createUser({ username, password: hashedPassword, full_name, email, phone_number, department, role: role || 'user', location, manager, manager_id: managerId, employee_id, join_date, access_level: accessLevel });
    if (newUser.email) void emitAutomationEvent('user_registered', { email: newUser.email, userId: newUser.id, eventKey: `user:${newUser.id}` });

    const created = await getUserProfile(newUser.id);
    res.status(201).json({
      message: 'User registered successfully.',
      user: presentUser(req.user, created),
    });
  } catch (error) {
    next(error);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const user = await buildSessionUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
};

// Fields a user may change on their own profile. Job role and manager are set by an
// administrator; access level only through the Administration access controls.
const SELF_EDITABLE = ['full_name', 'email', 'phone_number', 'department', 'location', 'employee_id', 'join_date', 'bio', 'profile_photo_url'];

const updateProfile = async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileData = Object.fromEntries(SELF_EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
    if (can(req.user.access_level, 'users.edit')) {
      if (body.role !== undefined) profileData.role = body.role;
      if (body.manager_id !== undefined) {
        if (body.manager_id !== null && String(body.manager_id) === String(req.user.id)) {
          return res.status(400).json({ message: 'You cannot be your own manager.' });
        }
        profileData.manager_id = body.manager_id;
      } else if (body.manager !== undefined) {
        profileData.manager_id = body.manager ? await findManagerIdByName(body.manager, req.user.id) : null;
        profileData.manager = body.manager || undefined;
      }
    }
    const updatedUser = await updateUserProfile(req.user.id, profileData);
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: await buildSessionUser(req.user.id) });
  } catch (error) {
    next(error);
  }
};

const uploadProfilePhoto = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'Profile photo file is required.' });
    }

    const ext = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '';
    const storageKey = `profile-photos/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${ext}`;
    await storage.upload(storageKey, file.buffer, file.mimetype);

    let profilePhotoUrl;
    if (typeof storage.getUrl === 'function') {
      // S3 storage: the provider returns the full public URL
      profilePhotoUrl = await storage.getUrl(storageKey);
    } else {
      // Local storage: use the public address from .env (works behind Apache and under /adms),
      // and fall back to the request's own host only if it is not set.
      const publicFiles = (process.env.PUBLIC_FILES_URL || `${req.protocol}://${req.get('host')}/files`).replace(/\/$/, '');
      profilePhotoUrl = `${publicFiles}/${storageKey}`;
    }

    const updatedUser = await updateUserProfile(req.user.id, { profile_photo_url: profilePhotoUrl });
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: await buildSessionUser(req.user.id) });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, encryptedCurrentPassword, encryptedNewPassword } = req.body;

    const currentPlain = resolvePassword(currentPassword, encryptedCurrentPassword);
    const newPlain = resolvePassword(newPassword, encryptedNewPassword);

    if (!currentPlain || !newPlain) {
      return res.status(400).json({ message: 'Current and new passwords are required.' });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const isValidPassword = await bcrypt.compare(currentPlain, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(newPlain, SALT_ROUNDS);
    await updateUserPassword(userId, hashedPassword);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    next(error);
  }
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        message: `User with email ${req.body.email} does not exist.`,
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await setPasswordResetToken(user.id, resetToken, expiresAt);
    await sendResetPasswordEmail(user.email, resetToken);

    res.json({
      message: `Reset link has been sent to ${req.body.email}.`,
    });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword, encryptedNewPassword } = req.body;

    const newPlain = resolvePassword(newPassword, encryptedNewPassword);

    if (!token || !newPlain) {
      return res.status(400).json({ message: 'Reset token and new password are required.' });
    }

    const user = await findUserByResetToken(token);
    if (!user || !user.reset_token_expires || new Date() > user.reset_token_expires) {
      return res.status(400).json({ message: 'Reset token is invalid or expired.' });
    }

    const hashedPassword = await bcrypt.hash(newPlain, SALT_ROUNDS);
    await updateUserPassword(user.id, hashedPassword);

    res.json({ message: 'Password updated successfully.' });
  } catch (error) {
    next(error);
  }
};

const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required.' });
    }

    const user = await findUserByRefreshToken(refreshToken);
    if (!user || !user.refresh_token_expires || new Date() > user.refresh_token_expires) {
      return res.status(403).json({ message: 'Refresh token is invalid or expired.' });
    }

    const { accessToken, refreshToken: newRefreshToken } = await buildTokens(user);
    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authorization required.' });
    }

    await clearRefreshToken(userId);
    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    next(error);
  }
};

const sendUserError = (res, error) => {
  if (error instanceof UserDeletionError) return res.status(error.status).json({ message: error.message, code: error.code });
  if (String(error?.message || '').includes('ADMS_LAST_SUPERADMIN')) {
    return res.status(409).json({ message: 'At least one Superadmin must remain.', code: 'LAST_SUPERADMIN' });
  }
  return null;
};

/** GET /auth/users?search&accessLevel&status&sortBy&order&page&pageSize (Admin, Superadmin) */
const listUsers = async (req, res, next) => {
  try {
    const { search, accessLevel, status, sortBy, order, page, pageSize } = req.query;
    const [result, summary] = await Promise.all([
      searchUsers({ search, accessLevel, status, sortBy, order, page, pageSize }),
      getUserSummary(),
    ]);
    res.json({
      ...result,
      users: result.users.map((user) => presentUser(req.user, user)),
      summary,
      // Options for the access-level filter and select; the API decides who may assign which.
      accessLevels: LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] })),
    });
  } catch (error) { next(error); }
};

/** GET /auth/users/summary (Admin, Superadmin) */
const usersSummary = async (req, res, next) => {
  try { res.json(await getUserSummary()); } catch (error) { next(error); }
};

/** GET /auth/users/managers?search — id, name, email and job role only (Admin, Superadmin) */
const managerOptions = async (req, res, next) => {
  try {
    const excludeId = req.query.exclude ? parseInt(req.query.exclude, 10) : null;
    res.json(await findManagerOptions({ excludeId: Number.isFinite(excludeId) ? excludeId : null, search: req.query.search || '' }));
  } catch (error) { next(error); }
};

/** GET /auth/users/:id (Admin, Superadmin) */
const getUser = async (req, res, next) => {
  try {
    const user = await getUserProfile(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const level = normalizeLevel(user.access_level);
    res.json({ user: { ...user, access_level_label: LEVEL_LABELS[level], permissions: capabilityLabelsFor(level), actions: actionsFor(req.user, user) } });
  } catch (error) { next(error); }
};

const ADMIN_EDITABLE = ['full_name', 'email', 'phone_number', 'department', 'role', 'location', 'employee_id', 'join_date', 'bio'];

/** PATCH /auth/users/:id — profile fields, manager and (if allowed) access level, in one transaction. */
const updateUser = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [target] } = await client.query('SELECT id, access_level FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found.' });
    }
    if (!canEditUser(req.user.access_level, target.access_level)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Only a Superadmin can edit a Superadmin.' });
    }
    const body = req.body || {};
    const fields = Object.fromEntries(ADMIN_EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
    if (fields.role !== undefined && !String(fields.role).trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Role cannot be empty.' });
    }
    if (body.manager_id !== undefined) {
      if (body.manager_id !== null && String(body.manager_id) === String(target.id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'A user cannot be their own manager.' });
      }
      fields.manager_id = body.manager_id;
    }
    if (body.access_level !== undefined && normalizeLevel(body.access_level) !== target.access_level) {
      const accessError = accessChangeError({ actorId: req.user.id, actorLevel: req.user.access_level, targetId: target.id, fromLevel: target.access_level, toLevel: body.access_level });
      if (accessError) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: accessError });
      }
      await setUserAccessLevel(target.id, normalizeLevel(body.access_level), client);
    }
    await updateUserProfile(target.id, fields, client);
    await client.query('COMMIT');
    const user = await getUserProfile(target.id);
    res.json({ user: presentUser(req.user, user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (!sendUserError(res, error)) next(error);
  } finally {
    client.release();
  }
};

const changeAccessLevel = async (req, res, toLevel) => {
  const { rows: [target] } = await pool.query('SELECT id, access_level FROM users WHERE id = $1', [req.params.id]);
  if (!target) return res.status(404).json({ message: 'User not found.' });
  const accessError = accessChangeError({ actorId: req.user.id, actorLevel: req.user.access_level, targetId: target.id, fromLevel: target.access_level, toLevel });
  if (accessError) return res.status(403).json({ message: accessError });
  const user = await setUserAccessLevel(target.id, normalizeLevel(toLevel));
  return res.json({ user: presentUser(req.user, user) });
};

/** PATCH /auth/users/:id/access { access_level } */
const updateAccessLevel = async (req, res, next) => {
  try { await changeAccessLevel(req, res, req.body?.access_level); } catch (error) { if (!sendUserError(res, error)) next(error); }
};

/** PATCH /auth/users/:id/admin { is_admin } — older endpoint, same rules as /access. */
const updateAdminStatus = async (req, res, next) => {
  try {
    const { rows: [target] } = await pool.query('SELECT access_level FROM users WHERE id = $1', [req.params.id]);
    if (!target) return res.status(404).json({ message: 'User not found.' });
    let toLevel = target.access_level;
    if (req.body?.is_admin === true && target.access_level === 'user') toLevel = 'admin';
    if (req.body?.is_admin === false) toLevel = 'user';
    await changeAccessLevel(req, res, toLevel);
  } catch (error) { if (!sendUserError(res, error)) next(error); }
};

/** GET /auth/users/:id/deletion-impact (Superadmin) */
const userDeletionImpact = async (req, res, next) => {
  try {
    const impact = await getDeletionImpact(req.params.id);
    if (!impact) return res.status(404).json({ message: 'User not found.' });
    const blockers = [];
    if (String(req.user.id) === String(impact.user.id)) blockers.push('You cannot delete your own account.');
    if (impact.user.accessLevel === 'superadmin') {
      const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE access_level = 'superadmin'");
      if (n <= 1) blockers.push('This is the only Superadmin. Make someone else Superadmin first.');
    }
    res.json({ ...impact, blockers });
  } catch (error) { next(error); }
};

/** DELETE /auth/users/:id (Superadmin) — permanent. */
const deleteUser = async (req, res, next) => {
  try {
    const result = await deleteUserAccount({ actor: req.user, targetId: req.params.id, io: req.app.get('io') });
    console.log(`[user-delete] user ${req.params.id} deleted by ${req.user.id} (${req.user.username})`);
    res.json({ message: 'User and their personal data were deleted.', ...result });
  } catch (error) {
    if (!sendUserError(res, error)) next(error);
  }
};

const listRoles = async (req, res, next) => {
  try {
    res.json(await findRoles());
  } catch (error) { next(error); }
};

const getRolePermissions = async (req, res, next) => {
  try {
    res.json(await findRolePermissions(req.params.role));
  } catch (error) { next(error); }
};

const saveRolePermissions = async (req, res, next) => {
  try {
    const values = req.body || {};
    res.json(await updateRolePermissions(req.params.role, {
      view: values.view === true,
      download: values.download === true,
      upload: values.upload === true,
      edit: values.edit === true,
      delete_permission: values.delete_permission === true,
      share: values.share === true,
      copy: values.copy === true,
      // Kept for older databases; Campaigns access now follows the access level (Admin, Superadmin).
      campaigns_view: values.campaigns_view === true,
      campaigns_edit: values.campaigns_edit === true,
    }));
  } catch (error) { next(error); }
};

/** PATCH /auth/users/:id/role { role } — job role. */
const updateRole = async (req, res, next) => {
  try {
    const role = String(req.body?.role || '').trim();
    if (!role) return res.status(400).json({ message: 'Role is required.' });
    const { rows: [target] } = await pool.query('SELECT access_level FROM users WHERE id = $1', [req.params.id]);
    if (!target) return res.status(404).json({ message: 'User not found.' });
    if (!canEditUser(req.user.access_level, target.access_level)) return res.status(403).json({ message: 'Only a Superadmin can edit a Superadmin.' });
    const user = await updateUserRole(req.params.id, role);
    res.json({ user });
  } catch (error) { next(error); }
};

module.exports = {
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
};
