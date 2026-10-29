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

const createUser = async ({ username, password, full_name, email, phone_number, department, role = 'user', location, manager, manager_id = null, employee_id, join_date, is_admin = false, access_level = null }) => {
  const level = access_level || (is_admin ? 'admin' : 'user');
  const result = await pool.query(
    `INSERT INTO users (username, password, full_name, email, phone_number, department, role, location, manager,
       employee_id, join_date, is_admin, access_level, manager_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
       COALESCE((SELECT COALESCE(NULLIF(TRIM(full_name), ''), username) FROM users WHERE id = $14::int), $9),
       $10, $11::date, $12, $13, $14::int)
     RETURNING *`,
    [username, password, full_name, email, phone_number, department, role, location, manager, employee_id, join_date || null, level !== 'user', level, manager_id || null]
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

// Columns safe to return to the client (no password or token columns). The manager's name
// comes from the linked user (manager_id); the older free-text users.manager is the fallback.
const PUBLIC_USER_SELECT = `
  u.id, u.username, u.full_name, u.email, u.phone_number, u.department, u.role, u.access_level, u.is_admin,
  u.location, u.employee_id, u.join_date::text AS join_date, u.bio, u.profile_photo_url,
  u.created_at, u.activated_at, u.last_seen,
  u.manager_id,
  COALESCE(NULLIF(TRIM(m.full_name), ''), m.username, NULLIF(TRIM(u.manager), '')) AS manager,
  m.email AS manager_email,
  CASE WHEN u.activated_at IS NOT NULL THEN 'active' ELSE 'pending' END AS status`;
const PUBLIC_USER_FROM = 'FROM users u LEFT JOIN users m ON m.id = u.manager_id';

const getUserProfile = async (id) => {
  const result = await pool.query(`SELECT ${PUBLIC_USER_SELECT} ${PUBLIC_USER_FROM} WHERE u.id = $1`, [id]);
  return result.rows[0] || null;
};

/**
 * Updates profile fields; undefined / null leaves a field as it is. Pass manager_id
 * (a user id, or null to clear) to change the manager link; users.manager then keeps
 * that manager's name for older code.
 */
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
    manager_id,
    employee_id,
    join_date,
    bio,
    profile_photo_url,
  },
  db = pool
) => {
  const changeManager = manager_id !== undefined;
  const managerId = changeManager && manager_id !== null && manager_id !== '' ? parseInt(manager_id, 10) : null;
  const result = await db.query(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         email = COALESCE($3, email),
         phone_number = COALESCE($4, phone_number),
         department = COALESCE($5, department),
         role = COALESCE($6, role),
         location = COALESCE($7, location),
         manager = CASE WHEN $13 THEN (SELECT COALESCE(NULLIF(TRIM(mm.full_name), ''), mm.username) FROM users mm WHERE mm.id = $14::int)
                        ELSE COALESCE($8, manager) END,
         manager_id = CASE WHEN $13 THEN $14::int ELSE manager_id END,
         employee_id = COALESCE($9, employee_id),
         join_date = COALESCE($10::date, join_date),
         bio = COALESCE($11, bio),
         profile_photo_url = COALESCE($12, profile_photo_url)
     WHERE id = $1
    RETURNING id`,
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
      join_date || null,
      bio,
      profile_photo_url,
      changeManager,
      Number.isFinite(managerId) ? managerId : null,
    ]
  );
  if (!result.rows[0]) return null;
  const { rows: [user] } = await db.query(`SELECT ${PUBLIC_USER_SELECT} ${PUBLIC_USER_FROM} WHERE u.id = $1`, [id]);
  return user || null;
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
  // The users trigger keeps access_level in step (true: User -> Admin, false: -> User).
  const result = await pool.query(
    'UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING id, username, full_name, email, role, is_admin, access_level',
    [id, isAdmin]
  );
  return result.rows[0] || null;
};

const findAllUsers = async () => {
  const result = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.department, u.role, u.access_level, u.is_admin, u.profile_photo_url,
            u.manager_id, COALESCE(NULLIF(TRIM(m.full_name), ''), m.username, NULLIF(TRIM(u.manager), '')) AS manager
     ${PUBLIC_USER_FROM} ORDER BY u.full_name NULLS LAST, u.username`
  );
  return result.rows;
};

const USER_SORTS = {
  name: "LOWER(COALESCE(NULLIF(TRIM(u.full_name), ''), u.username))",
  email: 'LOWER(u.email)',
  role: 'LOWER(u.role)',
  access_level: "CASE u.access_level WHEN 'superadmin' THEN 2 WHEN 'admin' THEN 1 ELSE 0 END",
  manager: "LOWER(COALESCE(NULLIF(TRIM(m.full_name), ''), m.username, u.manager))",
  status: '(u.activated_at IS NOT NULL)',
  created_at: 'u.created_at',
};

/** One page of users for Administration, with filters and sorting done in the database. */
const searchUsers = async ({ search, accessLevel, status, sortBy = 'name', order = 'asc', page = 1, pageSize = 10 } = {}) => {
  const where = [];
  const values = [];
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(u.full_name ILIKE $${values.length} OR u.username ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
  }
  if (['superadmin', 'admin', 'user'].includes(accessLevel)) {
    values.push(accessLevel);
    where.push(`u.access_level = $${values.length}`);
  }
  if (status === 'active') where.push('u.activated_at IS NOT NULL');
  if (status === 'pending') where.push('u.activated_at IS NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortSql = USER_SORTS[sortBy] || USER_SORTS.name;
  const dir = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 10));
  const current = Math.max(1, parseInt(page, 10) || 1);

  const [list, count] = await Promise.all([
    pool.query(
      `SELECT ${PUBLIC_USER_SELECT} ${PUBLIC_USER_FROM} ${whereSql}
       ORDER BY ${sortSql} ${dir} NULLS LAST, u.id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, size, (current - 1) * size]
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${PUBLIC_USER_FROM} ${whereSql}`, values),
  ]);
  return { users: list.rows, total: count.rows[0].total, page: current, pageSize: size };
};

/** Counts for the Administration summary cards, straight from the users table. */
const getUserSummary = async () => {
  const { rows: [row] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS active,
            COUNT(*) FILTER (WHERE activated_at IS NULL)::int AS pending,
            COUNT(*) FILTER (WHERE access_level = 'admin')::int AS admins,
            COUNT(*) FILTER (WHERE access_level = 'superadmin')::int AS superadmins,
            COUNT(*) FILTER (WHERE access_level = 'user')::int AS users
       FROM users`
  );
  return row;
};

/** People who can be picked as someone's manager: id, name, email and job role only. */
const findManagerOptions = async ({ excludeId = null, search = '' } = {}) => {
  const values = [excludeId];
  let filter = '';
  if (String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    filter = `AND (full_name ILIKE $2 OR username ILIKE $2 OR email ILIKE $2)`;
  }
  const result = await pool.query(
    `SELECT id, COALESCE(NULLIF(TRIM(full_name), ''), username) AS name, email, role
       FROM users
      WHERE ($1::int IS NULL OR id <> $1::int) ${filter}
      ORDER BY (LOWER(TRIM(role)) = 'manager') DESC, LOWER(COALESCE(NULLIF(TRIM(full_name), ''), username))
      LIMIT 200`,
    values
  );
  return result.rows;
};

/** The unique user whose full name or username matches, for older clients that send a manager name. */
const findManagerIdByName = async (name, excludeId) => {
  if (!name || !String(name).trim()) return null;
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE id <> $2 AND LOWER(TRIM($1)) IN (LOWER(TRIM(COALESCE(full_name, ''))), LOWER(TRIM(username)))
      LIMIT 2`,
    [name, excludeId]
  );
  return rows.length === 1 ? rows[0].id : null;
};

const setUserAccessLevel = async (id, accessLevel, db = pool) => {
  const result = await db.query('UPDATE users SET access_level = $2 WHERE id = $1 RETURNING id', [id, accessLevel]);
  if (!result.rows[0]) return null;
  const { rows: [user] } = await db.query(`SELECT ${PUBLIC_USER_SELECT} ${PUBLIC_USER_FROM} WHERE u.id = $1`, [id]);
  return user;
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
  const result = await pool.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, username, full_name, email, role, is_admin, access_level', [id, role]);
  return result.rows[0] || null;
};

module.exports = {
  PUBLIC_USER_SELECT,
  PUBLIC_USER_FROM,
  searchUsers,
  getUserSummary,
  findManagerOptions,
  findManagerIdByName,
  setUserAccessLevel,
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