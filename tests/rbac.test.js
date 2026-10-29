/* eslint-disable no-console */
/**
 * Integration tests for access levels, the users API, user deletion and document access.
 * Uses the real routes against a PostgreSQL database with the ADMS schema
 * (a development copy, never production):
 *
 *   RBAC_TEST=1 DB_HOST=... DB_PORT=... DB_DATABASE=adms_dev DB_USER=... DB_PASSWORD=... \
 *     node --test --test-concurrency=1 tests/rbac/rbac.test.js
 *
 * Everything it creates uses a run id prefix and is removed at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

if (process.env.RBAC_TEST !== '1') {
  test('RBAC integration tests (set RBAC_TEST=1 and point DB_* at a development database)', { skip: true }, () => {});
  return;
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rbac-test';
process.env.STORAGE_PROVIDER = 'local';
const RUN = `rb${Date.now().toString(36)}`;
let api; let server; let pool; let storage; let jwt;
const ids = {};
const tokens = {};
const cleanup = { users: [], documents: [], photos: [], conversations: [], folders: [], newsletters: [], files: [] };

const call = async (who, method, url, body) => {
  const r = await fetch(`${api}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who] || who}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const addUser = async (name, level, extra = {}) => {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, password, full_name, email, role, access_level, activated_at, manager_id)
     VALUES ($1, 'x', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [`${RUN}${name}`, extra.fullName || `${RUN} ${name}`, `${RUN}${name}@example.test`, extra.role || 'user', level,
      extra.activated === false ? null : new Date(), extra.managerId || null]
  );
  cleanup.users.push(u.id);
  ids[name] = u.id;
  tokens[name] = jwt.sign({ id: u.id, username: `${RUN}${name}` }, process.env.JWT_SECRET);
  return u.id;
};

test.before(async () => {
  pool = require('../../src/config/db');
  await require('../../src/config/initDb')();
  storage = require('../../src/storage');
  jwt = require('jsonwebtoken');
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.set('io', null);
  app.use('/api', require('../../src/routes/routes'));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: err.message }); }); // eslint-disable-line no-unused-vars
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  api = `http://127.0.0.1:${server.address().port}/api`;

  await addUser('super', 'superadmin', { fullName: `${RUN} Super Person` });
  await addUser('super2', 'superadmin');
  await addUser('admin', 'admin', { fullName: `${RUN} Admin Person` });
  await addUser('boss', 'user', { role: 'Manager', fullName: `${RUN} Boss Manager` });
  await addUser('user', 'user', { role: 'Software Engineer', managerId: ids.boss, fullName: `${RUN} Regular User` });
  await addUser('newbie', 'user', { activated: false });
});

test.after(async () => {
  for (const key of cleanup.files) await storage.delete(key).catch(() => {});
  if (cleanup.conversations.length) await pool.query('DELETE FROM conversations WHERE id = ANY($1)', [cleanup.conversations]);
  if (cleanup.documents.length) await pool.query('DELETE FROM documents WHERE id = ANY($1)', [cleanup.documents]);
  if (cleanup.photos.length) await pool.query('DELETE FROM gallery_photos WHERE id = ANY($1)', [cleanup.photos]);
  if (cleanup.folders.length) await pool.query('DELETE FROM folders WHERE folder_key = ANY($1)', [cleanup.folders]);
  if (cleanup.newsletters.length) await pool.query('DELETE FROM newsletters WHERE id = ANY($1)', [cleanup.newsletters]).catch(() => {});
  await pool.query("DELETE FROM role_permissions WHERE role LIKE $1", [`${RUN}%`]);
  // Superadmins last, so the "keep one Superadmin" trigger never blocks the cleanup.
  await pool.query("DELETE FROM users WHERE id = ANY($1) AND access_level <> 'superadmin'", [cleanup.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanup.users]).catch((error) => console.error('cleanup:', error.message));
  server?.close();
  await pool.end();
});

test('profile: a regular user gets their own profile with role, manager and permissions (no admin API needed)', async () => {
  const r = await call('user', 'GET', '/auth/profile');
  assert.equal(r.status, 200);
  const u = r.body.user;
  assert.equal(u.id, ids.user);
  assert.equal(u.access_level, 'user');
  assert.equal(u.role, 'Software Engineer');
  assert.equal(u.manager, `${RUN} Boss Manager`);
  assert.equal(u.manager_id, ids.boss);
  assert.equal(u.capabilities['admin.access'], false);
  assert.equal(u.capabilities['campaigns.access'], false);
  assert.equal(u.capabilities['documents.view'], true);
  assert.ok(Array.isArray(u.permissions) && u.permissions.length > 0);
  assert.equal(u.password, undefined);
  assert.equal(u.refresh_token, undefined);

  const list = await call('user', 'GET', '/auth/users');
  assert.equal(list.status, 403, 'the full user list stays restricted');
  assert.equal((await call('user', 'GET', '/auth/users/managers')).status, 403);
});

test('profile: a regular user cannot change their own role, manager or access level', async () => {
  const r = await call('user', 'PUT', '/auth/profile', { role: 'HR', manager_id: ids.admin, access_level: 'superadmin', is_admin: true, location: 'Chennai' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'Software Engineer');
  assert.equal(r.body.user.manager_id, ids.boss);
  assert.equal(r.body.user.access_level, 'user');
  assert.equal(r.body.user.location, 'Chennai');
});

test('users list: paginated, searchable, filterable, sortable, with summary and manager', async () => {
  const r = await call('admin', 'GET', `/auth/users?search=${RUN}&pageSize=2&page=1&sortBy=name&order=asc`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 6);
  assert.equal(r.body.users.length, 2);
  assert.equal(r.body.pageSize, 2);
  const page3 = await call('admin', 'GET', `/auth/users?search=${RUN}&pageSize=2&page=3&sortBy=name&order=asc`);
  assert.equal(page3.body.users.length, 2);
  const names = [...r.body.users, ...page3.body.users].map((u) => u.full_name);
  assert.equal(new Set(names).size, 4, 'pages do not overlap');

  const regular = (await call('admin', 'GET', `/auth/users?search=${RUN}%20Regular`)).body.users[0];
  assert.equal(regular.manager, `${RUN} Boss Manager`);
  assert.equal(regular.status, 'active');

  const admins = await call('admin', 'GET', `/auth/users?search=${RUN}&accessLevel=superadmin`);
  assert.equal(admins.body.total, 2);
  const pending = await call('admin', 'GET', `/auth/users?search=${RUN}&status=pending`);
  assert.equal(pending.body.total, 1);
  assert.equal(pending.body.users[0].id, ids.newbie);

  const byLevel = await call('admin', 'GET', `/auth/users?search=${RUN}&sortBy=access_level&order=desc&pageSize=10`);
  assert.equal(byLevel.body.users[0].access_level, 'superadmin');
  assert.equal(byLevel.body.users.at(-1).access_level, 'user');

  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE access_level = 'superadmin')::int AS superadmins,
            COUNT(*) FILTER (WHERE access_level = 'admin')::int AS admins, COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS active FROM users`);
  assert.deepEqual(
    { total: r.body.summary.total, superadmins: r.body.summary.superadmins, admins: r.body.summary.admins, active: r.body.summary.active },
    counts,
    'summary cards come from the users table'
  );

  const row = r.body.users[0];
  assert.equal(typeof row.actions.canEdit, 'boolean');
  assert.equal((await call('admin', 'GET', '/auth/users?search=%25')).status, 200, 'wildcards in search are treated as text');
});

test('actions per row: admins cannot delete, superadmins can (except themselves)', async () => {
  const asAdmin = (await call('admin', 'GET', `/auth/users?search=${RUN}&pageSize=10`)).body.users;
  assert.ok(asAdmin.every((u) => u.actions.canDelete === false));
  assert.equal(asAdmin.find((u) => u.id === ids.super).actions.canEdit, false, 'admins cannot edit a superadmin');
  const asSuper = (await call('super', 'GET', `/auth/users?search=${RUN}&pageSize=10`)).body.users;
  assert.equal(asSuper.find((u) => u.id === ids.user).actions.canDelete, true);
  assert.equal(asSuper.find((u) => u.id === ids.super).actions.canDelete, false);
});

test('access levels: only a superadmin grants or removes superadmin; admins manage user/admin', async () => {
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.newbie}/access`, { access_level: 'superadmin' })).status, 403);
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.super2}/access`, { access_level: 'user' })).status, 403);
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.super2}`, { full_name: 'x' })).status, 403, 'admin cannot edit a superadmin');
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.super2}/admin`, { is_admin: false })).status, 403, 'old endpoint follows the same rule');
  assert.equal((await call('user', 'PATCH', `/auth/users/${ids.newbie}/access`, { access_level: 'admin' })).status, 403);

  let r = await call('admin', 'PATCH', `/auth/users/${ids.newbie}/access`, { access_level: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.access_level, 'admin');
  assert.equal(r.body.user.is_admin, true);
  r = await call('admin', 'PATCH', `/auth/users/${ids.newbie}/access`, { access_level: 'user' });
  assert.equal(r.body.user.access_level, 'user');

  r = await call('super', 'PATCH', `/auth/users/${ids.admin}/access`, { access_level: 'superadmin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.access_level, 'superadmin');
  r = await call('super', 'PATCH', `/auth/users/${ids.admin}/access`, { access_level: 'admin' });
  assert.equal(r.body.user.access_level, 'admin');

  assert.equal((await call('super', 'PATCH', `/auth/users/${ids.super}/access`, { access_level: 'admin' })).status, 403, 'no self-demotion');
  assert.equal((await call('super', 'PATCH', `/auth/users/${ids.user}/access`, { access_level: 'root' })).status, 403);
});

test('adding users: admins add users and admins, only a superadmin adds a superadmin', async () => {
  const base = { password: 'Secret123', full_name: 'New Person', role: 'user' };
  assert.equal((await call('user', 'POST', '/auth/register', { ...base, username: `${RUN}x1`, email: `${RUN}x1@example.test` })).status, 403);
  const asAdmin = await call('admin', 'POST', '/auth/register', { ...base, username: `${RUN}x2`, email: `${RUN}x2@example.test`, access_level: 'admin', manager_id: ids.boss });
  assert.equal(asAdmin.status, 201, JSON.stringify(asAdmin.body));
  cleanup.users.push(asAdmin.body.user.id);
  assert.equal(asAdmin.body.user.access_level, 'admin');
  assert.equal(asAdmin.body.user.manager, `${RUN} Boss Manager`);
  assert.equal((await call('admin', 'POST', '/auth/register', { ...base, username: `${RUN}x3`, email: `${RUN}x3@example.test`, access_level: 'superadmin' })).status, 403);
  const asSuper = await call('super', 'POST', '/auth/register', { ...base, username: `${RUN}x4`, email: `${RUN}x4@example.test`, access_level: 'superadmin' });
  assert.equal(asSuper.status, 201);
  cleanup.users.push(asSuper.body.user.id);
  assert.equal((await call('user', 'GET', `/auth/users/${ids.admin}`)).status, 403);
  assert.equal((await call('admin', 'GET', `/auth/users/${ids.user}`)).body.user.manager, `${RUN} Boss Manager`);
});

test('the database never allows removing the last superadmin', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE users SET access_level = 'admin' WHERE access_level = 'superadmin' AND NOT (id = ANY($1))", [[ids.super, ids.super2]]);
    await client.query('UPDATE users SET access_level = $2 WHERE id = $1', [ids.super2, 'admin']);
    await assert.rejects(client.query('UPDATE users SET access_level = $2 WHERE id = $1', [ids.super, 'user']), /ADMS_LAST_SUPERADMIN/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('admin edit: profile fields, manager and access in one call', async () => {
  const r = await call('admin', 'PATCH', `/auth/users/${ids.newbie}`, { department: 'QA', manager_id: ids.boss, role: 'Testing Engineer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.department, 'QA');
  assert.equal(r.body.user.manager, `${RUN} Boss Manager`);
  assert.equal(r.body.user.role, 'Testing Engineer');
  assert.equal((await call('admin', 'PATCH', `/auth/users/${ids.newbie}`, { manager_id: ids.newbie })).status, 400);
  const managers = await call('admin', 'GET', `/auth/users/managers?search=${RUN}&exclude=${ids.newbie}`);
  assert.equal(managers.status, 200);
  assert.ok(managers.body.every((m) => m.id !== ids.newbie));
  assert.deepEqual(Object.keys(managers.body[0]).sort(), ['email', 'id', 'name', 'role']);
});

test('role permissions: admins can read them, only a superadmin can change them', async () => {
  const role = `${RUN}role`;
  assert.equal((await call('admin', 'GET', `/auth/roles/${role}/permissions`)).status, 200);
  assert.equal((await call('user', 'GET', '/auth/roles')).status, 403);
  assert.equal((await call('admin', 'PUT', `/auth/roles/${role}/permissions`, { view: true })).status, 403);
  assert.equal((await call('super', 'PUT', `/auth/roles/${role}/permissions`, { view: true, download: true })).status, 200);
});

test('campaigns: admins and superadmins only, including direct API calls', async () => {
  assert.equal((await call('user', 'GET', '/newsletters')).status, 403);
  assert.equal((await call('user', 'POST', '/newsletters', { title: 'x' })).status, 403);
  assert.equal((await call('user', 'GET', '/newsletters/dashboard')).status, 403);
  assert.equal((await call('user', 'GET', '/automations')).status, 403);
  assert.deepEqual((await call('user', 'GET', '/newsletters/access')).body, { admin: false, edit: false, view: false });
  assert.equal((await call('admin', 'GET', '/newsletters')).status, 200);
  assert.equal((await call('super', 'GET', '/newsletters')).status, 200);
  assert.equal((await call('user', 'GET', '/newsletters/published')).status, 200, 'published newsletters stay readable');
});

test('documents and gallery: users view and download what they may; only admins change anything', async () => {
  const { rows: [open] } = await pool.query(
    `INSERT INTO documents (title, original_filename, mime_type, size_bytes, storage_key, uploaded_by)
     VALUES ($1, 'open.txt', 'text/plain', 4, $2, $3) RETURNING id`, [`${RUN} open`, `documents/${RUN}/open.txt`, ids.admin]);
  const { rows: [hidden] } = await pool.query(
    `INSERT INTO documents (title, original_filename, mime_type, size_bytes, storage_key, uploaded_by)
     VALUES ($1, 'hidden.txt', 'text/plain', 4, $2, $3) RETURNING id`, [`${RUN} hidden`, `documents/${RUN}/hidden.txt`, ids.admin]);
  const { rows: [viewOnly] } = await pool.query(
    `INSERT INTO documents (title, original_filename, mime_type, size_bytes, storage_key, uploaded_by)
     VALUES ($1, 'view.txt', 'text/plain', 4, $2, $3) RETURNING id`, [`${RUN} viewonly`, `documents/${RUN}/view.txt`, ids.admin]);
  cleanup.documents.push(open.id, hidden.id, viewOnly.id);
  for (const name of ['open', 'hidden', 'view']) {
    await storage.upload(`documents/${RUN}/${name}.txt`, Buffer.from('data'));
    cleanup.files.push(`documents/${RUN}/${name}.txt`);
  }
  await pool.query('INSERT INTO document_permissions (document_id, user_id, view, download) VALUES ($1, $2, FALSE, FALSE), ($3, $2, TRUE, FALSE)', [hidden.id, ids.user, viewOnly.id]);

  const list = await call('user', 'GET', `/documents?search=${RUN}&pageSize=50`);
  assert.equal(list.status, 200);
  const titles = list.body.documents.map((d) => d.title).sort();
  assert.deepEqual(titles, [`${RUN} open`, `${RUN} viewonly`]);
  assert.equal(list.body.totalCount, 2);
  const vo = list.body.documents.find((d) => d.id === viewOnly.id);
  assert.equal(vo.can_download, false);
  assert.equal(vo.storage_key, null, 'no direct file key without download permission');
  assert.equal(list.body.documents.find((d) => d.id === open.id).can_download, true);

  assert.equal((await call('user', 'GET', `/documents/${hidden.id}`)).status, 404);
  assert.equal((await call('user', 'GET', `/documents/${hidden.id}/download`)).status, 404);
  assert.equal((await call('user', 'GET', `/documents/${viewOnly.id}/download`)).status, 403);
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM download_history WHERE user_id = $1', [ids.user])).rows[0].n;
  const preview = await fetch(`${api}/documents/${viewOnly.id}/download?preview=1`, { headers: { Authorization: `Bearer ${tokens.user}` } });
  assert.equal(preview.status, 200, 'view-only documents can still be previewed');
  assert.match(preview.headers.get('content-disposition'), /^inline/);
  await preview.text();
  const after = (await pool.query('SELECT COUNT(*)::int AS n FROM download_history WHERE user_id = $1', [ids.user])).rows[0].n;
  assert.equal(after, before, 'a preview is not counted as a download');
  assert.equal((await call('user', 'GET', `/documents/${hidden.id}/download?preview=1`)).status, 404);
  const dl = await fetch(`${api}/documents/${open.id}/download`, { headers: { Authorization: `Bearer ${tokens.user}` } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'data');

  const adminList = await call('admin', 'GET', `/documents?search=${RUN}&pageSize=50`);
  assert.equal(adminList.body.totalCount, 3, 'admins see everything');

  assert.equal((await call('user', 'DELETE', `/documents/${open.id}`)).status, 403);
  assert.equal((await call('user', 'PATCH', `/documents/${open.id}`, { title: 'hacked' })).status, 403);
  assert.equal((await call('user', 'POST', '/documents/folders', { name: `${RUN}f` })).status, 403);
  assert.equal((await call('user', 'PUT', `/documents/${open.id}/permissions/${ids.user}`, { view: true, download: true })).status, 403);
  assert.equal((await call('user', 'POST', '/documents/upload')).status, 403);
  assert.equal((await call('user', 'POST', '/gallery/upload')).status, 403);
  assert.equal((await call('user', 'DELETE', '/gallery/bulk', { ids: [1] })).status, 403);
  assert.equal((await call('user', 'POST', '/gallery/folders', { name: 'x' })).status, 403);
  const created = await call('admin', 'POST', '/documents/folders', { name: `${RUN}folder` });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  await pool.query('DELETE FROM folders WHERE name = $1', [`${RUN}folder`]);
  assert.equal((await call('user', 'GET', '/gallery')).status, 200);
});

const seedUserData = async (victim, other) => {
  const data = {};
  // A direct chat with messages both ways, a file attachment and a shared document.
  const { rows: [direct] } = await pool.query("INSERT INTO conversations (type, created_by) VALUES ('direct', $1) RETURNING id", [victim]);
  const { rows: [group] } = await pool.query("INSERT INTO conversations (type, name, created_by) VALUES ('group', $2, $1) RETURNING id", [victim, `${RUN} group`]);
  cleanup.conversations.push(direct.id, group.id);
  await pool.query('INSERT INTO conversation_participants (conversation_id, user_id, is_admin) VALUES ($1, $2, FALSE), ($1, $3, FALSE), ($4, $2, TRUE), ($4, $3, FALSE), ($4, $5, FALSE)',
    [direct.id, victim, other, group.id, ids.boss]);
  const attachmentKey = `chat/${RUN}/${victim}-attachment.txt`;
  await storage.upload(attachmentKey, Buffer.from('mine'));
  cleanup.files.push(attachmentKey);
  const photoKey = `profile-photos/${RUN}/${victim}-me.png`;
  await storage.upload(photoKey, Buffer.from('png'));
  cleanup.files.push(photoKey);
  await pool.query('UPDATE users SET profile_photo_url = $2 WHERE id = $1', [victim, `http://localhost/files/${photoKey}`]);

  const docKey = `documents/${RUN}/${victim}-uploaded.txt`;
  await storage.upload(docKey, Buffer.from('shared doc'));
  cleanup.files.push(docKey);
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, original_filename, mime_type, size_bytes, storage_key, uploaded_by) VALUES ($1, 'u.txt', 'text/plain', 10, $2, $3) RETURNING id`,
    [`${RUN} uploaded by victim`, docKey, victim]);
  cleanup.documents.push(doc.id);
  const { rows: [photo] } = await pool.query(
    `INSERT INTO gallery_photos (title, original_filename, mime_type, size_bytes, storage_key, uploaded_by) VALUES ($1, 'p.png', 'image/png', 3, $2, $3) RETURNING id`,
    [`${RUN} photo by victim`, `gallery/${RUN}/p.png`, victim]);
  cleanup.photos.push(photo.id);

  await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type) VALUES ($1, $2, 'from victim', 'text'), ($1, $3, 'from other', 'text'), ($4, $2, 'victim in group', 'text'), ($4, $3, 'other in group', 'text')`,
    [direct.id, victim, other, group.id]);
  await pool.query(`INSERT INTO messages (conversation_id, sender_id, content, message_type, storage_key, original_filename) VALUES ($1, $2, 'file', 'document', $3, 'a.txt'), ($1, $2, 'shared doc', 'document', $4, 'u.txt')`,
    [direct.id, victim, attachmentKey, docKey]);
  const { rows: [msgOther] } = await pool.query("SELECT id FROM messages WHERE conversation_id = $1 AND sender_id = $2", [direct.id, other]);
  await pool.query('INSERT INTO dashboard_shared_hidden (user_id, message_id) VALUES ($1, $2)', [victim, msgOther.id]);

  const { rows: [call1] } = await pool.query("INSERT INTO calls (conversation_id, caller_id) VALUES ($1, $2) RETURNING id", [direct.id, victim]);
  await pool.query("INSERT INTO call_participants (call_id, user_id, role) VALUES ($1, $2, 'caller'), ($1, $3, 'callee')", [call1.id, victim, other]);
  await pool.query("INSERT INTO user_favorites (user_id, item_type, item_id) VALUES ($1, 'document', $2)", [victim, doc.id]);
  await pool.query("INSERT INTO download_history (user_id, item_type, item_id) VALUES ($1, 'document', $2), ($3, 'document', $2)", [victim, doc.id, other]);
  await pool.query('INSERT INTO document_acknowledgements (document_id, user_id) VALUES ($1, $2), ($1, $3)', [doc.id, victim, other]);
  await pool.query('INSERT INTO document_permissions (document_id, user_id, view, download) VALUES ($1, $2, TRUE, TRUE)', [doc.id, victim]);
  await pool.query('INSERT INTO gallery_comments (gallery_item_id, user_id, comment) VALUES ($1, $2, $3), ($1, $4, $5)', [photo.id, victim, 'victim comment', other, 'other comment']);
  await pool.query('UPDATE users SET manager_id = $1, manager = $2 WHERE id = $3', [victim, 'Victim', ids.newbie]);
  await pool.query("INSERT INTO events (title, event_date, created_by) VALUES ($1, CURRENT_DATE, $2)", [`${RUN} event`, victim]).catch(() => {});
  // A table this code base does not know about, pointing at users without an ON DELETE rule.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${RUN}_notes (id SERIAL PRIMARY KEY, author_id INTEGER REFERENCES users(id))`);
  await pool.query(`INSERT INTO ${RUN}_notes (author_id) VALUES ($1)`, [victim]);
  const { rows: [nl] } = await pool.query("INSERT INTO newsletters (title, subject, html_content, created_by, updated_by) VALUES ($1, 's', '<p>x</p>', $2, $2) RETURNING id", [`${RUN} nl`, victim]).catch(() => ({ rows: [{}] }));
  if (nl.id) cleanup.newsletters.push(nl.id);
  Object.assign(data, { direct: direct.id, group: group.id, attachmentKey, photoKey, docKey, doc: doc.id, photo: photo.id, call: call1.id, newsletter: nl.id });
  return data;
};

test('deletion rules: admins cannot delete, nobody deletes themselves', async () => {
  assert.equal((await call('admin', 'DELETE', `/auth/users/${ids.user}`)).status, 403);
  assert.equal((await call('admin', 'GET', `/auth/users/${ids.user}/deletion-impact`)).status, 403);
  assert.equal((await call('user', 'DELETE', `/auth/users/${ids.newbie}`)).status, 403);
  const self = await call('super', 'DELETE', `/auth/users/${ids.super}`);
  assert.equal(self.status, 400);
  assert.equal(self.body.code, 'SELF_DELETE');
  assert.equal((await call('super', 'DELETE', '/auth/users/99999999')).status, 404);
  assert.equal((await call('super', 'DELETE', '/auth/users/abc')).status, 400);
});

test('a failed deletion changes nothing (single transaction)', async () => {
  const victim = await addUser('rollback', 'user');
  const data = await seedUserData(victim, ids.user);
  // Make the final DELETE of the user row fail.
  await pool.query(`CREATE OR REPLACE FUNCTION ${RUN}_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER ${RUN}_fail BEFORE DELETE ON users FOR EACH ROW WHEN (OLD.id = ${victim}) EXECUTE FUNCTION ${RUN}_fail()`);
  try {
    const r = await call('super', 'DELETE', `/auth/users/${victim}`);
    assert.equal(r.status, 500);
  } finally {
    await pool.query(`DROP TRIGGER ${RUN}_fail ON users`);
    await pool.query(`DROP FUNCTION ${RUN}_fail()`);
  }
  const { rows: [after] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM users WHERE id = $1)::int AS users, (SELECT COUNT(*) FROM messages WHERE sender_id = $1)::int AS messages,
            (SELECT COUNT(*) FROM conversation_participants WHERE user_id = $1)::int AS memberships,
            (SELECT uploaded_by FROM documents WHERE id = $2) AS uploader`, [victim, data.doc]);
  assert.deepEqual(after, { users: 1, messages: 4, memberships: 2, uploader: victim });
  assert.ok(fs.existsSync(storage.getPath(data.attachmentKey)), 'files are only deleted after commit');
});

test('superadmin deletes a user: personal data removed, shared data and other users kept, sessions revoked', async () => {
  const victim = await addUser('victim', 'admin');
  await pool.query("UPDATE users SET refresh_token = 'rt-victim', refresh_token_expires = NOW() + INTERVAL '1 day' WHERE id = $1", [victim]);
  const data = await seedUserData(victim, ids.user);

  const impact = await call('super', 'GET', `/auth/users/${victim}/deletion-impact`);
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.body.blockers, []);
  assert.equal(impact.body.removed.messages, 4);
  assert.equal(impact.body.removed.directChats, 1);
  assert.equal(impact.body.removed.groupChats, 1);
  assert.equal(impact.body.removed.profilePhoto, true);
  assert.equal(impact.body.kept.documents, 1);
  assert.equal(impact.body.kept.photos, 1);
  assert.equal(impact.body.kept.directReports, 1);

  assert.equal((await call('victim', 'GET', '/auth/profile')).status, 200, 'token works before deletion');
  const r = await call('super', 'DELETE', `/auth/users/${victim}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.filesFailed, 0);

  const q = async (sql, params = [victim]) => (await pool.query(sql, params)).rows[0].n;
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM users WHERE id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM messages WHERE sender_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM conversation_participants WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM call_participants WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM user_favorites WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM download_history WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM document_acknowledgements WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM document_permissions WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM gallery_comments WHERE user_id = $1'), 0);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM dashboard_shared_hidden WHERE user_id = $1'), 0);

  // Other people's records are untouched.
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM messages WHERE sender_id = $1 AND conversation_id = ANY($2)', [ids.user, [data.direct, data.group]]), 2);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM download_history WHERE user_id = $1 AND item_id = $2', [ids.user, data.doc]), 1);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM document_acknowledgements WHERE user_id = $1 AND document_id = $2', [ids.user, data.doc]), 1);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM gallery_comments WHERE user_id = $1 AND gallery_item_id = $2', [ids.user, data.photo]), 1);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM call_participants WHERE call_id = $1', [data.call]), 1);
  assert.equal(await q('SELECT caller_id AS n FROM calls WHERE id = $1', [data.call]), null);

  // Shared content is kept, without the link to the deleted person.
  assert.equal(await q('SELECT uploaded_by AS n FROM documents WHERE id = $1', [data.doc]), null);
  assert.equal(await q('SELECT uploaded_by AS n FROM gallery_photos WHERE id = $1', [data.photo]), null);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM conversations WHERE id = $1', [data.direct]), 1);
  assert.equal(await q('SELECT created_by AS n FROM conversations WHERE id = $1', [data.group]), null);
  assert.equal(await q('SELECT COUNT(*)::int AS n FROM conversation_participants WHERE conversation_id = $1 AND is_admin', [data.group]), 1, 'the group got a new admin');
  assert.equal(await q('SELECT manager_id AS n FROM users WHERE id = $1', [ids.newbie]), null);
  assert.equal(await q(`SELECT COUNT(*)::int AS n FROM ${RUN}_notes WHERE author_id IS NULL`, []), 1, 'unknown nullable references are cleared');
  await pool.query(`DROP TABLE ${RUN}_notes`);
  if (data.newsletter) assert.equal(await q('SELECT created_by AS n FROM newsletters WHERE id = $1', [data.newsletter]), null);

  // Files: the user's own are gone; a shared document's file is not.
  assert.equal(fs.existsSync(storage.getPath(data.attachmentKey)), false);
  assert.equal(fs.existsSync(storage.getPath(data.photoKey)), false);
  assert.equal(fs.existsSync(storage.getPath(data.docKey)), true);

  // Sessions: the access token and the refresh token stop working.
  const after = await call('victim', 'GET', '/auth/profile');
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'ACCOUNT_REMOVED');
  assert.equal((await call(null, 'POST', '/auth/refresh-token', { refreshToken: 'rt-victim' })).status, 403);

  // The other person sees the chat with a deleted user and cannot write to it.
  const conversations = await call('user', 'GET', '/chat/conversations');
  const chat = conversations.body.conversations.find((c) => c.conversationId === data.direct);
  assert.equal(chat.otherUser.deleted, true);
  assert.equal(chat.otherUser.fullName, 'Deleted user');
});

test('a superadmin can delete another superadmin while one remains, never the last', async () => {
  const extra = await addUser('super3', 'superadmin');
  const r = await call('super', 'DELETE', `/auth/users/${extra}`);
  assert.equal(r.status, 200);
  const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE access_level = 'superadmin'");
  assert.ok(n >= 1);
});

test('migration is idempotent', async () => {
  await require('../../src/config/initDb')();
  await require('../../src/config/initDb')();
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname IN ('trg_users_access_sync', 'trg_users_keep_superadmin')");
  assert.equal(rows[0].n, 2);
});
