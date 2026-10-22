const pool = require('../config/db');

const findUserByUsername = async (username) => {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0] || null;
};

const findUserByEmail = async (email) => {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
};

const findUserById = async (id) => {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
};

const createUser = async ({ username, password, full_name, email, phone_number, department, role = 'user', location, manager, employee_id, join_date, is_admin = false }) => {
  const result = await pool.query(
    `INSERT INTO users (username, password, full_name, email, phone_number, department, role, location, manager,
       employee_id, join_date, is_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12)
     RETURNING *`,
    [username, password, full_name, email, phone_number, department, role, location, manager, employee_id, join_date, is_admin]
  );
  return result.rows[0];
};

// Returns the user only the first time it is activated (first successful sign-in).
const markUserActivated = async (id) => {
  const result = await pool.query(
    'UPDATE users SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL RETURNING id, email',
    [id]
  );
  return result.rows[0] || null;
};

const updateUserPassword = async (id, password) => {
  const result = await pool.query(
    'UPDATE users SET password = $2, reset_token = NULL, reset_token_expires = NULL WHERE id = $1 RETURNING *',
    [id, password]
  );
  return result.rows[0] || null;
};

const getUserProfile = async (id) => {
  const result = await pool.query(
    `SELECT id, username, full_name, email, phone_number, department, role, is_admin, location, manager, employee_id,
            join_date::text AS join_date, bio, profile_photo_url
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const updateUserProfile = async (
  id,
  {
    full_name,
    email,
    phone_number,
    department,
    role,
    location,
    manager,
    employee_id,
    join_date,
    bio,
    profile_photo_url,
  }
) => {
  const result = await pool.query(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         email = COALESCE($3, email),
         phone_number = COALESCE($4, phone_number),
         department = COALESCE($5, department),
         role = COALESCE($6, role),
         location = COALESCE($7, location),
         manager = COALESCE($8, manager),
         employee_id = COALESCE($9, employee_id),
         join_date = COALESCE($10::date, join_date),
         bio = COALESCE($11, bio),
         profile_photo_url = COALESCE($12, profile_photo_url)
     WHERE id = $1
    RETURNING id, username, full_name, email, phone_number, department, role, is_admin, location, manager, employee_id,
        join_date::text AS join_date, bio, profile_photo_url`,
    [
      id,
      full_name,
      email,
      phone_number,
      department,
      role,
      location,
      manager,
      employee_id,
      join_date,
      bio,
      profile_photo_url,
    ]
  );
  return result.rows[0] || null;
};

const setPasswordResetToken = async (userId, token, expiresAt) => {
  const result = await pool.query(
    'UPDATE users SET reset_token = $2, reset_token_expires = $3 WHERE id = $1 RETURNING *',
    [userId, token, expiresAt]
  );
  return result.rows[0] || null;
};

const findUserByResetToken = async (token) => {
  const result = await pool.query('SELECT * FROM users WHERE reset_token = $1', [token]);
  return result.rows[0] || null;
};

const findUserByRefreshToken = async (refreshToken) => {
  const result = await pool.query('SELECT * FROM users WHERE refresh_token = $1', [refreshToken]);
  return result.rows[0] || null;
};

const setRefreshToken = async (userId, token, expiresAt) => {
  const result = await pool.query(
    'UPDATE users SET refresh_token = $2, refresh_token_expires = $3 WHERE id = $1 RETURNING *',
    [userId, token, expiresAt]
  );
  return result.rows[0] || null;
};

const clearRefreshToken = async (userId) => {
  const result = await pool.query(
    'UPDATE users SET refresh_token = NULL, refresh_token_expires = NULL WHERE id = $1 RETURNING *',
    [userId]
  );
  return result.rows[0] || null;
};

// Lightweight directory listing used by the chat module to let a user pick
// a colleague to start a conversation with (id + display info only — no
// password/token columns).
const findAllUsersExcept = async (userId) => {
  const result = await pool.query(
    `SELECT id, username, full_name, email, department, role, is_admin, profile_photo_url, last_seen
     FROM users
     WHERE id != $1
     ORDER BY full_name NULLS LAST, username`,
    [userId]
  );
  return result.rows;
};

const updateUserAdminStatus = async (id, isAdmin) => {
  const result = await pool.query(
    'UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING id, username, full_name, email, role, is_admin',
    [id, isAdmin]
  );
  return result.rows[0] || null;
};

const findAllUsers = async () => {
  const result = await pool.query(
    `SELECT id, username, full_name, email, department, role, is_admin, profile_photo_url
     FROM users ORDER BY full_name NULLS LAST, username`
  );
  return result.rows;
};

const findRoles = async () => {
  const result = await pool.query("SELECT DISTINCT role FROM users WHERE role IS NOT NULL AND TRIM(role) <> '' ORDER BY role");
  return [...new Set(['user', ...result.rows.map((row) => row.role)])];
};

const findRolePermissions = async (role) => {
  const result = await pool.query('SELECT * FROM role_permissions WHERE role = $1', [role]);
  return result.rows[0] || { role, view: true, download: true, upload: false, edit: false, delete_permission: false, share: true, copy: false, campaigns_view: false, campaigns_edit: false };
};

const updateRolePermissions = async (role, permissions) => {
  const result = await pool.query(
    `INSERT INTO role_permissions (role, view, download, upload, edit, delete_permission, share, copy, campaigns_view, campaigns_edit, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (role) DO UPDATE SET view=$2, download=$3, upload=$4, edit=$5, delete_permission=$6, share=$7, copy=$8,
       campaigns_view=$9, campaigns_edit=$10, updated_at=NOW()
     RETURNING *`,
    [role, permissions.view, permissions.download, permissions.upload, permissions.edit, permissions.delete_permission, permissions.share, permissions.copy,
      Boolean(permissions.campaigns_view || permissions.campaigns_edit), Boolean(permissions.campaigns_edit)]
  );
  return result.rows[0];
};

const updateUserRole = async (id, role) => {
  const result = await pool.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, username, full_name, email, role, is_admin', [id, role]);
  return result.rows[0] || null;
};

module.exports = {
  markUserActivated,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  findAllUsersExcept,
  findAllUsers,
  updateUserAdminStatus,
  findRoles,
  findRolePermissions,
  updateRolePermissions,
  updateUserRole,
  createUser,
  updateUserPassword,
  getUserProfile,
  updateUserProfile,
  setPasswordResetToken,
  findUserByResetToken,
  findUserByRefreshToken,
  setRefreshToken,
  clearRefreshToken,
};