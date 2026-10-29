const { can, CAPABILITIES } = require('../config/accessPolicy');

/**
 * Route guard: 403 unless the signed-in user's access level has the capability.
 * Must run after authenticateToken. Capabilities are defined in config/accessPolicy.js.
 */
const requireCapability = (capability) => {
  if (!CAPABILITIES[capability]) throw new Error(`Unknown capability: ${capability}`);
  return (req, res, next) => {
    if (can(req.user?.access_level, capability)) return next();
    return res.status(403).json({
      message: `You do not have permission for this action (${CAPABILITIES[capability].label}).`,
      code: 'FORBIDDEN',
      capability,
    });
  };
};

module.exports = { requireCapability };
