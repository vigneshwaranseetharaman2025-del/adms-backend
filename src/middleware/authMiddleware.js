const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { normalizeLevel, can } = require('../config/accessPolicy');

/**
 * Verifies the access token, then reloads the user from the database on every request,
 * so a changed access level applies at once and a deleted user's token stops working
 * (401 ACCOUNT_REMOVED) even before it expires.
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header missing or malformed.' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Access token is missing.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token.'});
    }
    try {
      const { rows: [currentUser] } = await pool.query(
        'SELECT id, username, role, access_level FROM users WHERE id = $1',
        [user.id]
      );
      if (!currentUser) {
        return res.status(401).json({ message: 'This account no longer exists.', code: 'ACCOUNT_REMOVED' });
      }
      const accessLevel = normalizeLevel(currentUser.access_level);
      req.user = {
        ...user,
        id: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
        access_level: accessLevel,
        is_admin: can(accessLevel, 'admin.access'),
      };
      next();
    } catch (error) {
      next(error);
    }
  });
};

module.exports = {
  authenticateToken,
};
