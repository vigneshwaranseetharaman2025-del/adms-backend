
const { can } = require('../config/accessPolicy');

/**
 * Who may use the Campaigns module: Admins and Superadmins (config/accessPolicy.js,
 * capability "campaigns.access"). Everyone else gets 403, so the module cannot be reached
 * through direct URLs or API calls either. Must run after authenticateToken, which loads
 * the current access level from the database on every request.
 *
 * (role_permissions.campaigns_view / campaigns_edit are kept in the database but no longer
 * grant access to regular users.)
 */
const loadCampaignAccess = async (req) => {
  if (req.campaignAccess) return req.campaignAccess;
  const allowed = can(req.user?.access_level, 'campaigns.access');
  req.campaignAccess = { admin: allowed, edit: allowed, view: allowed };
  return req.campaignAccess;
};

const guard = (level, message) => async (req, res, next) => {
  try {
    const access = await loadCampaignAccess(req);
    if (!access[level]) return res.status(403).json({ message, code: 'CAMPAIGN_ACCESS' });
    next();
  } catch (error) { next(error); }
};

const requireCampaignView = guard('view', 'The Email Campaigns module is available to Admins and Superadmins only.');
const requireCampaignEdit = guard('edit', 'The Email Campaigns module is available to Admins and Superadmins only.');
const requireCampaignAdmin = guard('admin', 'Administrator access is required.');

/** GET routes need view access; everything else needs edit access. */
const byMethod = (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? requireCampaignView : requireCampaignEdit)(req, res, next);

module.exports = { loadCampaignAccess, requireCampaignView, requireCampaignEdit, requireCampaignAdmin, byMethod };
