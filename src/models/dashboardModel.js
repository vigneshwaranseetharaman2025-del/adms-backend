const pool = require('../config/db');

const itemQuery = `
  SELECT f.item_type, f.item_id, f.created_at,
    CASE WHEN f.item_type = 'document' THEN d.title ELSE g.title END AS title,
    CASE WHEN f.item_type = 'document' THEN d.original_filename ELSE g.original_filename END AS original_filename,
    CASE WHEN f.item_type = 'document' THEN d.mime_type ELSE g.mime_type END AS mime_type,
    CASE WHEN f.item_type = 'document' THEN d.size_bytes ELSE g.size_bytes END AS size_bytes,
    CASE WHEN f.item_type = 'document' THEN d.storage_key ELSE g.storage_key END AS storage_key,
    CASE WHEN f.item_type = 'document' THEN d.thumbnail_key ELSE g.thumbnail_key END AS thumbnail_key,
    CASE WHEN f.item_type = 'document' THEN d.uploaded_at ELSE g.uploaded_at END AS uploaded_at
  FROM user_favorites f
  LEFT JOIN documents d ON f.item_type = 'document' AND d.id = f.item_id
  LEFT JOIN gallery_photos g ON f.item_type = 'gallery' AND g.id = f.item_id
  WHERE f.user_id = $1 AND ((f.item_type = 'document' AND d.id IS NOT NULL) OR (f.item_type = 'gallery' AND g.id IS NOT NULL))
  ORDER BY f.created_at DESC
  LIMIT 100`;

const getFavorites = async (userId) => (await pool.query(itemQuery, [userId])).rows;

const getEvents = async () => (await pool.query(
  `SELECT id, title, TO_CHAR(event_date, 'YYYY-MM-DD') AS date,
    TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime", color
   FROM events ORDER BY event_date ASC, start_time ASC, id ASC`
)).rows;

const getDashboardDocuments = async (keyword, limit) => (await pool.query(
  `SELECT d.*, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username
   FROM documents d
   LEFT JOIN folders f ON f.folder_key = d.folder_id
   LEFT JOIN users u ON u.id = d.uploaded_by
   WHERE LOWER(CONCAT_WS(' ', f.name, f.folder_key, d.folder_id)) LIKE $1
   ORDER BY d.uploaded_at DESC NULLS LAST, d.id DESC
   LIMIT $2`, [`%${keyword}%`, limit]
)).rows;

const getRecentGalleries = async () => (await pool.query(
    `SELECT f.folder_key AS id, f.name, f.event_date, f.category, COUNT(g.id)::int AS photo_count,
      latest.thumbnail_key, latest.storage_key, latest.event_date AS latest_event_date,
      latest.uploaded_at AS latest_uploaded_at
   FROM gallery_folders f
   JOIN gallery_photos g ON g.folder_id = f.folder_key
   LEFT JOIN LATERAL (
    SELECT thumbnail_key, storage_key, uploaded_at, COALESCE(event_date, f.event_date) AS event_date
     FROM gallery_photos
     WHERE folder_id = f.folder_key
     ORDER BY uploaded_at DESC NULLS LAST, id DESC
     LIMIT 1
   ) latest ON true
  GROUP BY f.folder_key, f.name, f.event_date, f.category, latest.thumbnail_key, latest.storage_key, latest.event_date, latest.uploaded_at
   ORDER BY MAX(g.uploaded_at) DESC NULLS LAST, f.folder_key ASC
   LIMIT 8`
)).rows;

const getDashboardSummary = async (userId) => {
  const [[favorites, downloads, shared], recentActivity, events, templates, policies, galleries] = await Promise.all([
    Promise.all([getFavorites(userId), getDownloads(userId), getShared(userId)]),
    getRecentActivity(),
    getEvents(),
    getDashboardDocuments('template', 4),
    getDashboardDocuments('polic', 2),
    getRecentGalleries(),
  ]);
  return {
    documents: { templates, policies },
    quickActions: { favorites, downloads, shared },
    recentActivity,
    events,
    galleries,
  };
};

const createEvent = async ({ title, date, startTime, endTime, color }, userId) => (await pool.query(
  `INSERT INTO events (title, event_date, start_time, end_time, color, created_by)
   VALUES ($1, $2, $3, $4, $5, $6)
   RETURNING id, title, TO_CHAR(event_date, 'YYYY-MM-DD') AS date,
     TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime", color`,
  [title, date, startTime, endTime, color || 'primary.main', userId]
)).rows[0];

const updateEvent = async (id, { title, date, startTime, endTime, color }) => (await pool.query(
  `UPDATE events SET title = $1, event_date = $2, start_time = $3, end_time = $4,
    color = $5, updated_at = NOW() WHERE id = $6
   RETURNING id, title, TO_CHAR(event_date, 'YYYY-MM-DD') AS date,
     TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime", color`,
  [title, date, startTime, endTime, color || 'primary.main', id]
)).rows[0] || null;

const deleteEvent = async (id) => (await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [id])).rows[0] || null;

const getDownloads = async (userId) => {
  const result = await pool.query(`
    SELECT item_type, item_id, downloaded_at, title, original_filename, mime_type,
      size_bytes, storage_key, thumbnail_key
    FROM (
      SELECT h.item_type, h.item_id, h.downloaded_at,
      CASE WHEN h.item_type = 'document' THEN d.title ELSE g.title END AS title,
      CASE WHEN h.item_type = 'document' THEN d.original_filename ELSE g.original_filename END AS original_filename,
      CASE WHEN h.item_type = 'document' THEN d.mime_type ELSE g.mime_type END AS mime_type,
      CASE WHEN h.item_type = 'document' THEN d.size_bytes ELSE g.size_bytes END AS size_bytes,
      CASE WHEN h.item_type = 'document' THEN d.storage_key ELSE g.storage_key END AS storage_key,
      CASE WHEN h.item_type = 'document' THEN d.thumbnail_key ELSE g.thumbnail_key END AS thumbnail_key,
      ROW_NUMBER() OVER (PARTITION BY h.item_type, h.item_id ORDER BY h.downloaded_at DESC) AS row_number
      FROM download_history h
      LEFT JOIN documents d ON h.item_type = 'document' AND d.id = h.item_id
      LEFT JOIN gallery_photos g ON h.item_type = 'gallery' AND g.id = h.item_id
      WHERE h.user_id = $1 AND ((h.item_type = 'document' AND d.id IS NOT NULL) OR (h.item_type = 'gallery' AND g.id IS NOT NULL))
    ) downloads
    WHERE row_number = 1
    ORDER BY downloaded_at DESC LIMIT 100`, [userId]);
  return result.rows;
};

const getShared = async (userId) => {
  const result = await pool.query(`
    SELECT id, conversation_id, item_type, item_id, original_filename, mime_type,
      size_bytes, storage_key, thumbnail_key, created_at, conversation_name, sender_name
    FROM (
      SELECT m.id, m.conversation_id,
      CASE WHEN d.id IS NOT NULL THEN 'document' ELSE 'gallery' END AS item_type,
      COALESCE(d.id, g.id) AS item_id,
      m.original_filename, m.mime_type, m.size_bytes,
      m.storage_key, COALESCE(d.thumbnail_key, g.thumbnail_key) AS thumbnail_key,
      m.created_at, c.name AS conversation_name,
      COALESCE(u.full_name, u.username) AS sender_name,
      ROW_NUMBER() OVER (PARTITION BY m.storage_key ORDER BY m.created_at DESC, m.id DESC) AS row_number
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN documents d ON d.storage_key = m.storage_key
      LEFT JOIN gallery_photos g ON g.storage_key = m.storage_key
      WHERE m.sender_id = $1
        AND m.message_type IN ('image', 'document')
        AND m.storage_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM dashboard_shared_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
        AND (EXISTS (SELECT 1 FROM documents d WHERE d.storage_key = m.storage_key)
          OR EXISTS (SELECT 1 FROM gallery_photos g WHERE g.storage_key = m.storage_key))
    ) shared
    WHERE row_number = 1
    ORDER BY created_at DESC LIMIT 100`, [userId]);
  return result.rows;
};

const getRecentActivity = async () => {
  const result = await pool.query(`
    SELECT * FROM (
      SELECT 'commented' AS activity_type, c.id AS activity_id, c.created_at AS event_at,
        c.user_id AS actor_id, COALESCE(u.full_name, u.username, 'User') AS actor_name,
        u.profile_photo_url AS actor_avatar, 'gallery' AS item_type, g.id AS item_id,
        g.title, g.original_filename, g.mime_type, g.folder_id, c.comment AS note
      FROM gallery_comments c JOIN users u ON u.id = c.user_id JOIN gallery_photos g ON g.id = c.gallery_item_id
      UNION ALL
      SELECT 'signed', da.document_id, da.signed_at, da.user_id, COALESCE(u.full_name, u.username, 'User'),
        u.profile_photo_url, 'document', d.id, d.title, d.original_filename, d.mime_type, d.folder_id, NULL
      FROM document_acknowledgements da JOIN users u ON u.id = da.user_id JOIN documents d ON d.id = da.document_id
      UNION ALL
      SELECT 'downloaded', h.id, h.downloaded_at, h.user_id, COALESCE(u.full_name, u.username, 'User'),
        u.profile_photo_url, h.item_type, h.item_id,
        CASE WHEN h.item_type = 'document' THEN d.title ELSE g.title END,
        CASE WHEN h.item_type = 'document' THEN d.original_filename ELSE g.original_filename END,
        CASE WHEN h.item_type = 'document' THEN d.mime_type ELSE g.mime_type END,
        CASE WHEN h.item_type = 'document' THEN d.folder_id ELSE g.folder_id END, NULL
      FROM download_history h JOIN users u ON u.id = h.user_id
        LEFT JOIN documents d ON h.item_type = 'document' AND d.id = h.item_id
        LEFT JOIN gallery_photos g ON h.item_type = 'gallery' AND g.id = h.item_id
      WHERE (h.item_type = 'document' AND d.id IS NOT NULL) OR (h.item_type = 'gallery' AND g.id IS NOT NULL)
      UNION ALL
      SELECT 'shared', m.id, m.created_at, m.sender_id, COALESCE(u.full_name, u.username, 'User'),
        u.profile_photo_url, CASE WHEN d.id IS NOT NULL THEN 'document' ELSE 'gallery' END,
        COALESCE(d.id, g.id), COALESCE(d.title, g.title, m.original_filename), m.original_filename, m.mime_type,
        COALESCE(d.folder_id, g.folder_id), NULL
      FROM messages m JOIN users u ON u.id = m.sender_id
        LEFT JOIN documents d ON d.storage_key = m.storage_key
        LEFT JOIN gallery_photos g ON g.storage_key = m.storage_key
      WHERE m.message_type IN ('image', 'document') AND m.storage_key IS NOT NULL AND (d.id IS NOT NULL OR g.id IS NOT NULL)
      UNION ALL
      SELECT 'edited', d.id, d.edited_at, d.uploaded_by, COALESCE(u.full_name, u.username, 'User'),
        u.profile_photo_url, 'document', d.id, d.title, d.original_filename, d.mime_type, d.folder_id, NULL
      FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.edited_at IS NOT NULL
      UNION ALL
      SELECT 'edited', g.id, g.edited_at, g.uploaded_by, COALESCE(u.full_name, u.username, 'User'),
        u.profile_photo_url, 'gallery', g.id, g.title, g.original_filename, g.mime_type, g.folder_id, NULL
      FROM gallery_photos g LEFT JOIN users u ON u.id = g.uploaded_by WHERE g.edited_at IS NOT NULL
      UNION ALL
      SELECT 'folder_created', f.id, f.created_at, NULL, 'System', NULL,
        'document', NULL, f.name, NULL, NULL, f.folder_key, NULL
      FROM folders f
      UNION ALL
      SELECT 'folder_created', gf.id, gf.created_at, NULL, 'System', NULL,
        'gallery', NULL, gf.name, NULL, NULL, gf.folder_key, NULL
      FROM gallery_folders gf
    ) activity
    WHERE event_at IS NOT NULL
    ORDER BY event_at DESC, activity_id DESC
    LIMIT 50
  `);
  return result.rows;
};

const addFavorite = async (userId, itemType, itemId) => {
  const result = await pool.query(
    `INSERT INTO user_favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_type, item_id) DO NOTHING RETURNING *`,
    [userId, itemType, itemId]
  );
  return result.rows[0] || null;
};

const removeFavorite = async (userId, itemType, itemId) => {
  await pool.query('DELETE FROM user_favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3', [userId, itemType, itemId]);
};

const clearFavorites = async (userId) => {
  await pool.query('DELETE FROM user_favorites WHERE user_id = $1', [userId]);
};

const clearDownloads = async (userId, itemType, itemId) => {
  await pool.query('DELETE FROM download_history WHERE user_id = $1 AND item_type = $2 AND item_id = $3', [userId, itemType, itemId]);
};

const clearAllDownloads = async (userId) => {
  await pool.query('DELETE FROM download_history WHERE user_id = $1', [userId]);
};

const hideShared = async (userId, messageId) => {
  await pool.query(
    `INSERT INTO dashboard_shared_hidden (user_id, message_id)
     SELECT $1, related.id
     FROM messages selected
     JOIN messages related ON related.sender_id = selected.sender_id
       AND related.storage_key = selected.storage_key
     WHERE selected.id = $2 AND selected.sender_id = $1
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId, messageId]
  );
};

const hideAllShared = async (userId) => {
  await pool.query(
    `INSERT INTO dashboard_shared_hidden (user_id, message_id)
     SELECT $1, m.id
     FROM messages m
     WHERE m.sender_id = $1
       AND m.message_type IN ('image', 'document')
       AND m.storage_key IS NOT NULL
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId]
  );
};

const recordDownload = async (userId, itemType, itemId) => {
  await pool.query('INSERT INTO download_history (user_id, item_type, item_id) VALUES ($1, $2, $3)', [userId, itemType, itemId]);
};

module.exports = {
  getEvents, createEvent, updateEvent, deleteEvent, getFavorites, getDownloads, getShared, getRecentActivity, getDashboardSummary, addFavorite, removeFavorite, clearFavorites,
  clearDownloads, clearAllDownloads, hideShared, hideAllShared, recordDownload,
};