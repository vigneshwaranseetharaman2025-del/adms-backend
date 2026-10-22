const jwt = require('jsonwebtoken');
const { findUserById } = require('../models/userModel');

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
      const currentUser = await findUserById(user.id);
      req.user = { ...user, is_admin: Boolean(currentUser?.is_admin) };
      next();
    } catch (error) {
      next(error);
    }
  });
};

module.exports = {
  authenticateToken,
};