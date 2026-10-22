const pool = require('../config/db');

/**
 * Who may use the Campaigns module.
 *   - Administrators: everything (including sender domain settings).
 *   - Roles with "Campaigns: edit & send": create, edit, delete and send shared drafts, manage contacts and templates.
 *   - Roles with "Campaigns: view": see drafts, templates, contacts and reports, but not change or send anything.
 * Set per role under Administration. Must run after authenticateToken.
 */
const loadCampaignAccess = async (req) => {
  if (req.campaignAccess) return req.campaignAccess;
  const { rows: [row] } = await pool.query(
    `SELECT u.is_admin, COALESCE(rp.campaigns_view, FALSE) AS view, COALESCE(rp.campaigns_edit, FALSE) AS edit
     FROM users u
     LEFT JOIN role_permissions rp ON rp.role = COALESCE(NULLIF(TRIM(u.role), ''), 'user')
     WHERE u.id = $1`,
    [req.user?.id]
  );
  const admin = Boolean(row?.is_admin);
  const edit = admin || Boolean(row?.edit);
  req.campaignAccess = { admin, edit, view: edit || Boolean(row?.view) };
  return req.campaignAccess;
};

const guard = (level, message) => async (req, res, next) => {
  try {
    const access = await loadCampaignAccess(req);
    if (!access[level]) return res.status(403).json({ message, code: 'CAMPAIGN_ACCESS' });
    next();
  } catch (error) { next(error); }
};

const requireCampaignView = guard('view', 'You do not have access to Campaigns. Ask an administrator to enable "Campaigns: view" for your role.');
const requireCampaignEdit = guard('edit', 'Your role can view campaigns but not change or send them. Ask an administrator for "Campaigns: edit & send".');
const requireCampaignAdmin = guard('admin', 'Administrator access is required.');

/** GET routes need view access; everything else needs edit access. */
const byMethod = (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? requireCampaignView : requireCampaignEdit)(req, res, next);

module.exports = { loadCampaignAccess, requireCampaignView, requireCampaignEdit, requireCampaignAdmin, byMethod };
