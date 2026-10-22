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
} = require('../models/userModel');
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
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        phone_number: user.phone_number,
        department: user.department,
        role: user.role,
        is_admin: Boolean(user.is_admin),
        location: user.location,
        manager: user.manager,
        employee_id: user.employee_id,
        join_date: user.join_date,
        bio: user.bio,
        profile_photo_url: user.profile_photo_url,
      },
    });
  } catch (error) {
    next(error);
  }
};

const register = async (req, res, next) => {
  try {
    if (!req.user?.is_admin) {
      return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const { username, password, encryptedPassword, full_name, email, phone_number, department, role, location, manager, employee_id, join_date } = req.body;
    const decryptedPassword = resolvePassword(password, encryptedPassword);

    if (!username || !decryptedPassword) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists.' });
    }

    const hashedPassword = await bcrypt.hash(decryptedPassword, SALT_ROUNDS);
    const newUser = await createUser({ username, password: hashedPassword, full_name, email, phone_number, department, role: role || 'user', location, manager, employee_id, join_date, is_admin: false });
    if (newUser.email) void emitAutomationEvent('user_registered', { email: newUser.email, userId: newUser.id, eventKey: `user:${newUser.id}` });

    res.status(201).json({
      message: 'User registered successfully.',
      user: {
        id: newUser.id,
        username: newUser.username,
        full_name: newUser.full_name,
        email: newUser.email,
        phone_number: newUser.phone_number,
        department: newUser.department,
        role: newUser.role,
        location: newUser.location,
        manager: newUser.manager,
        employee_id: newUser.employee_id,
        join_date: newUser.join_date,
        is_admin: false,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const user = await getUserProfile(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const profileData = req.user?.is_admin
      ? req.body
      : { ...req.body, role: undefined };
    const updatedUser = await updateUserProfile(req.user.id, profileData);
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: updatedUser });
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
      profilePhotoUrl = await storage.getUrl(storageKey);
    } else {
      profilePhotoUrl = `${req.protocol}://${req.get('host')}/files/${storageKey}`;
    }

    const updatedUser = await updateUserProfile(req.user.id, { profile_photo_url: profilePhotoUrl });
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: updatedUser });
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

const listUsers = async (req, res, next) => {
  try {
    if (!req.user?.is_admin) {
      return res.status(403).json({ message: 'Administrator access is required.' });
    }
    res.json(await findAllUsers());
  } catch (error) { next(error); }
};

const updateAdminStatus = async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ message: 'Administrator access is required.' });
    if (String(req.user.id) === String(req.params.id) && req.body?.is_admin === false) {
      return res.status(400).json({ message: 'You cannot remove your own administrator access.' });
    }
    const updatedUser = await updateUserAdminStatus(req.params.id, req.body?.is_admin === true);
    if (!updatedUser) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: updatedUser });
  } catch (error) { next(error); }
};

const requireAdministrator = (req, res) => {
  if (!req.user?.is_admin) {
    res.status(403).json({ message: 'Administrator access is required.' });
    return false;
  }
  return true;
};

const listRoles = async (req, res, next) => {
  try {
    if (!requireAdministrator(req, res)) return;
    res.json(await findRoles());
  } catch (error) { next(error); }
};

const getRolePermissions = async (req, res, next) => {
  try {
    if (!requireAdministrator(req, res)) return;
    res.json(await findRolePermissions(req.params.role));
  } catch (error) { next(error); }
};

const saveRolePermissions = async (req, res, next) => {
  try {
    if (!requireAdministrator(req, res)) return;
    const values = req.body || {};
    res.json(await updateRolePermissions(req.params.role, {
      view: values.view === true,
      download: values.download === true,
      upload: values.upload === true,
      edit: values.edit === true,
      delete_permission: values.delete_permission === true,
      share: values.share === true,
      copy: values.copy === true,
      // Campaigns module: "edit & send" includes "view".
      campaigns_view: values.campaigns_view === true,
      campaigns_edit: values.campaigns_edit === true,
    }));
  } catch (error) { next(error); }
};

const updateRole = async (req, res, next) => {
  try {
    if (!requireAdministrator(req, res)) return;
    const role = String(req.body?.role || '').trim();
    if (!role) return res.status(400).json({ message: 'Role is required.' });
    const user = await updateUserRole(req.params.id, role);
    if (!user) return res.status(404).json({ message: 'User not found.' });
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
  updateAdminStatus,
  listRoles,
  getRolePermissions,
  saveRolePermissions,
  updateRole,
};
