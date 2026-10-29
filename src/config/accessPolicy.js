/**
 * Access levels and what each one may do. This is the single place the rules live:
 * the API guards (middleware/requireCapability.js) and the capabilities sent to the
 * frontend (login and GET /auth/profile) are both built from it, so menus and
 * buttons always match what the server allows.
 *
 *   superadmin  everything, including deleting users, changing role permissions and
 *               granting or removing Superadmin
 *   admin       Administration and Campaigns, manage documents and photos;
 *               cannot delete users or grant Superadmin
 *   user        view, preview and download the documents and photos they are allowed to
 *
 * A user's job role (users.role, e.g. "Software Engineer") is separate from the access
 * level. Role permissions (role_permissions) and per-document permissions
 * (document_permissions) still decide which documents a regular user may view or download.
 */

const LEVELS = ['superadmin', 'admin', 'user'];
const LEVEL_LABELS = { superadmin: 'Superadmin', admin: 'Admin', user: 'User' };
const LEVEL_RANK = { user: 0, admin: 1, superadmin: 2 };

const CAPABILITIES = {
  'dashboard.view': { label: 'Dashboard', levels: LEVELS },
  'documents.view': { label: 'View, preview and download permitted documents', levels: LEVELS },
  'gallery.view': { label: 'View, preview and download permitted photos', levels: LEVELS },
  'chat.use': { label: 'Chat', levels: LEVELS },
  'newsletters.read': { label: 'Read published newsletters', levels: LEVELS },
  'profile.edit': { label: 'Edit own profile', levels: LEVELS },
  'documents.manage': { label: 'Upload, edit, move and delete documents and folders', levels: ['superadmin', 'admin'] },
  'gallery.manage': { label: 'Upload, edit, move and delete photos and albums', levels: ['superadmin', 'admin'] },
  'admin.access': { label: 'Administration module', levels: ['superadmin', 'admin'] },
  'users.view': { label: 'View all users', levels: ['superadmin', 'admin'] },
  'users.create': { label: 'Add users', levels: ['superadmin', 'admin'] },
  'users.edit': { label: 'Edit users', levels: ['superadmin', 'admin'] },
  'users.grant_admin': { label: 'Grant or remove Admin access', levels: ['superadmin', 'admin'] },
  'campaigns.access': { label: 'Email Campaigns module', levels: ['superadmin', 'admin'] },
  'roles.manage': { label: 'Change role permissions', levels: ['superadmin'] },
  'users.delete': { label: 'Delete users and their data', levels: ['superadmin'] },
  'users.grant_superadmin': { label: 'Grant or remove Superadmin access', levels: ['superadmin'] },
};

const normalizeLevel = (value) => {
  const level = String(value || '').trim().toLowerCase();
  return LEVELS.includes(level) ? level : 'user';
};

const can = (level, capability) => Boolean(CAPABILITIES[capability]?.levels.includes(normalizeLevel(level)));

/** { 'users.delete': false, ... } for one access level. */
const capabilitiesFor = (level) =>
  Object.fromEntries(Object.keys(CAPABILITIES).map((key) => [key, can(level, key)]));

/** Labels of the capabilities a level has, for the profile's Permissions tab. */
const capabilityLabelsFor = (level) =>
  Object.entries(CAPABILITIES).filter(([key]) => can(level, key)).map(([, value]) => value.label);

/**
 * Whether `actor` may move `target` (currently at `fromLevel`) to `toLevel`.
 * Returns null when allowed, otherwise the reason.
 */
const accessChangeError = ({ actorId, actorLevel, targetId, fromLevel, toLevel }) => {
  const actor = normalizeLevel(actorLevel);
  if (!LEVELS.includes(String(toLevel || '').toLowerCase())) return 'Choose Superadmin, Admin or User.';
  const from = normalizeLevel(fromLevel);
  const to = normalizeLevel(toLevel);
  if (from === to) return null;
  if (!can(actor, 'users.grant_admin')) return 'Administrator access is required.';
  if ((from === 'superadmin' || to === 'superadmin') && !can(actor, 'users.grant_superadmin')) {
    return 'Only a Superadmin can grant or remove Superadmin access.';
  }
  if (String(actorId) === String(targetId) && LEVEL_RANK[to] < LEVEL_RANK[from]) {
    return 'You cannot lower your own access level. Ask another Superadmin.';
  }
  return null;
};

/** Admins may edit regular users and other admins; only a Superadmin may edit a Superadmin. */
const canEditUser = (actorLevel, targetLevel) =>
  can(actorLevel, 'users.edit') && (normalizeLevel(targetLevel) !== 'superadmin' || normalizeLevel(actorLevel) === 'superadmin');

module.exports = {
  LEVELS,
  LEVEL_LABELS,
  CAPABILITIES,
  normalizeLevel,
  can,
  capabilitiesFor,
  capabilityLabelsFor,
  accessChangeError,
  canEditUser,
};
