const pool = require('../config/db');

const ALLOWED_SORT_FIELDS = new Set(['title', 'uploaded_at', 'size_bytes', 'mime_type']);

const findGalleryItems = async ({ page = 1, pageSize, limit = 50, offset, folderId, search, sortBy = 'uploaded_at', order = 'desc' }) => {
  const queryParts = [];
  const values = [];
  const resolvedPage = Math.max(1, parseInt(page, 10) || 1);
  const resolvedPageSize = Math.max(1, parseInt(pageSize, 10) || parseInt(limit, 10) || 50);
  const resolvedOffset = Number.isFinite(parseInt(offset, 10))
    ? Math.max(0, parseInt(offset, 10))
    : (resolvedPage - 1) * resolvedPageSize;

  if (folderId) {
    values.push(folderId);
    values.push(`${folderId}/%`);
    queryParts.push(`(folder_id = $${values.length - 1} OR folder_id LIKE $${values.length})`);
  }

  if (search) {
    values.push(`%${search}%`);
    queryParts.push(`(title ILIKE $${values.length} OR description ILIKE $${values.length} OR original_filename ILIKE $${values.length})`);
  }

  const whereClause = queryParts.length ? `WHERE ${queryParts.join(' AND ')}` : '';
  const safeSortBy = ALLOWED_SORT_FIELDS.has(sortBy) ? sortBy : 'uploaded_at';
  const safeOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  values.push(resolvedPageSize);
  values.push(resolvedOffset);

  const query = `
    SELECT g.*, COALESCE(g.event_date, f.event_date) AS event_date, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username
    FROM gallery_photos g
    LEFT JOIN gallery_folders f ON f.folder_key = g.folder_id
    LEFT JOIN users u ON u.id = g.uploaded_by
    ${whereClause}
    ORDER BY g.${safeSortBy} ${safeOrder}, g.id ASC
    LIMIT $${values.length - 1}
    OFFSET $${values.length}
  `;

  const countValues = values.slice(0, -2);
  const countQuery = `SELECT COUNT(*) AS total_count FROM gallery_photos ${whereClause}`;

  const [itemsResult, countResult] = await Promise.all([
    pool.query(query, values),
    pool.query(countQuery, countValues),
  ]);

  return {
    items: itemsResult.rows,
    totalCount: parseInt(countResult.rows[0]?.total_count || '0', 10),
  };
};

const findGalleryItemById = async (id) => {
  const result = await pool.query(
    `SELECT g.*, COALESCE(g.event_date, f.event_date) AS event_date, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username
     FROM gallery_photos g
     LEFT JOIN gallery_folders f ON f.folder_key = g.folder_id
     LEFT JOIN users u ON u.id = g.uploaded_by
     WHERE g.id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const updateGalleryItem = async (id, { title, description, author, folder_id, event_date }) => {
  const result = await pool.query(
    `UPDATE gallery_photos
    SET title = COALESCE($1, title), description = COALESCE($2, description),
      author = COALESCE($3, author), folder_id = CASE WHEN $4 THEN $5 ELSE folder_id END,
      event_date = COALESCE($6, event_date),
      updated_at = NOW(), edited_at = NOW()
     WHERE id = $7
     RETURNING *`,
    [title ?? null, description ?? null, author ?? null, folder_id !== undefined, folder_id ?? null, event_date ?? null, id]
  );
  return result.rows[0] || null;
};

const findDistinctFolders = async () => {
  const result = await pool.query(
    `SELECT folder_id, COUNT(*) AS photo_count
     FROM gallery_photos
     WHERE folder_id IS NOT NULL
     GROUP BY folder_id
     ORDER BY photo_count DESC`
  );
  return result.rows.map((row) => ({ folderId: row.folder_id, count: parseInt(row.photo_count, 10) }));
};

const createGalleryItem = async ({ title, description, author, event_date, original_filename, mime_type, size_bytes, storage_key, thumbnail_key, folder_id, checksum, uploaded_by }) => {
  const result = await pool.query(
    `INSERT INTO gallery_photos (
      title,
      description,
      author,
      event_date,
      original_filename,
      mime_type,
      size_bytes,
      storage_key,
      thumbnail_key,
      folder_id,
      checksum,
      uploaded_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [title, description, author, event_date, original_filename, mime_type, size_bytes, storage_key, thumbnail_key, folder_id, checksum, uploaded_by]
  );
  return result.rows[0];
};

const deleteGalleryItemById = async (id) => {
  const result = await pool.query('DELETE FROM gallery_photos WHERE id = $1 RETURNING *', [id]);
  return result.rows[0] || null;
};

const findGalleryComments = async (galleryItemId) => {
  const result = await pool.query(
    `SELECT c.id, c.comment, c.user_id, c.created_at,
            u.full_name AS user_name, u.username, u.profile_photo_url
     FROM gallery_comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.gallery_item_id = $1
     ORDER BY c.created_at ASC, c.id ASC`,
    [galleryItemId]
  );
  return result.rows;
};

const createGalleryComment = async (galleryItemId, userId, comment) => {
  const result = await pool.query(
    `INSERT INTO gallery_comments (gallery_item_id, user_id, comment)
     VALUES ($1, $2, $3)
     RETURNING id, comment, user_id, created_at`,
    [galleryItemId, userId, comment]
  );
  return result.rows[0];
};

const deleteGalleryComment = async (commentId, galleryItemId, userId) => {
  const result = await pool.query(
    `DELETE FROM gallery_comments
     WHERE id = $1 AND gallery_item_id = $2 AND user_id = $3
     RETURNING id`,
    [commentId, galleryItemId, userId]
  );
  return result.rows[0] || null;
};

const createGalleryFolder = async ({ folder_key, name, description, parent_folder_key = null, event_date = null, category = null, rejectDuplicate = false }) => {
  const result = await pool.query(
    `INSERT INTO gallery_folders (folder_key, name, description, parent_folder_key, event_date, category)
     VALUES ($1, $2, $3, $4, $5, $6)
    ${rejectDuplicate ? '' : 'ON CONFLICT (folder_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, parent_folder_key = EXCLUDED.parent_folder_key, event_date = COALESCE(EXCLUDED.event_date, gallery_folders.event_date), category = COALESCE(EXCLUDED.category, gallery_folders.category)'}
     RETURNING *`,
    [folder_key, name, description, parent_folder_key, event_date, category]
  );
  return result.rows[0];
};

const findAllGalleryFolders = async () => {
  const result = await pool.query(
    `SELECT f.folder_key, f.name, f.description, f.parent_folder_key, f.event_date, f.category, COUNT(g.id) AS gallery_count
     FROM gallery_folders f
     LEFT JOIN gallery_photos g ON g.folder_id = f.folder_key
    GROUP BY f.folder_key, f.name, f.description, f.parent_folder_key, f.event_date, f.category
     ORDER BY f.folder_key ASC`
  );
  return result.rows.map((row) => ({
    folderId: row.folder_key,
    name: row.name,
    description: row.description,
    eventDate: row.event_date,
    category: row.category,
    parentFolderId: row.parent_folder_key,
    path: row.folder_key,
    count: parseInt(row.gallery_count, 10),
  }));
};

const updateGalleryFolderEventDate = async (folderKey, eventDate) => {
  const result = await pool.query(
    'UPDATE gallery_folders SET event_date = $1 WHERE folder_key = $2 RETURNING *',
    [eventDate, folderKey]
  );
  return result.rows[0] || null;
};

const updateGalleryFolderMetadata = async (folderKey, eventDate, category) => {
  const result = await pool.query(
    'UPDATE gallery_folders SET event_date = $1, category = $2 WHERE folder_key = $3 RETURNING *',
    [eventDate, category || null, folderKey]
  );
  return result.rows[0] || null;
};

const renameGalleryFolder = async (folderKey, newName) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const folderResult = await client.query(
      'SELECT folder_key, parent_folder_key FROM gallery_folders WHERE folder_key = $1 FOR UPDATE',
      [folderKey]
    );
    if (!folderResult.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const folder = folderResult.rows[0];
    const renamedKey = folder.parent_folder_key ? `${folder.parent_folder_key}/${newName}` : newName;
    if (renamedKey !== folderKey) {
      const conflict = await client.query('SELECT 1 FROM gallery_folders WHERE folder_key = $1', [renamedKey]);
      if (conflict.rows[0]) {
        const error = new Error('A folder with that name already exists.');
        error.status = 409;
        throw error;
      }
    }

    const descendants = await client.query(
      'SELECT folder_key FROM gallery_folders WHERE folder_key = $1 OR folder_key LIKE $2 ORDER BY LENGTH(folder_key) DESC',
      [folderKey, `${folderKey}/%`]
    );
    for (const descendant of descendants.rows) {
      const nextKey = descendant.folder_key === folderKey
        ? renamedKey
        : `${renamedKey}${descendant.folder_key.slice(folderKey.length)}`;
      await client.query(
        `UPDATE gallery_folders
         SET folder_key = $1::varchar,
             name = CASE WHEN folder_key = $2::varchar THEN $3::varchar ELSE name END,
             parent_folder_key = CASE
               WHEN parent_folder_key = $2::varchar THEN $1::varchar
               WHEN parent_folder_key LIKE $4::varchar THEN ($1::varchar || SUBSTRING(parent_folder_key FROM $5::integer))::varchar
               ELSE parent_folder_key
             END
         WHERE folder_key = $2::varchar`,
        [nextKey, descendant.folder_key, newName, `${folderKey}/%`, folderKey.length + 1]
      );
    }

    await client.query(
      'UPDATE gallery_photos SET folder_id = ($1::varchar || SUBSTRING(folder_id FROM $2::integer))::varchar WHERE folder_id = $3::varchar OR folder_id LIKE $4::varchar',
      [renamedKey, folderKey.length + 1, folderKey, `${folderKey}/%`]
    );
    await client.query('COMMIT');
    return { folderId: renamedKey, name: newName };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const deleteGalleryFolder = async (folderKey) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT folder_key FROM gallery_folders WHERE folder_key = $1 OR folder_key LIKE $2',
      [folderKey, `${folderKey}/%`]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM gallery_photos WHERE folder_id = $1 OR folder_id LIKE $2', [folderKey, `${folderKey}/%`]);
    await client.query('DELETE FROM gallery_folders WHERE folder_key = $1 OR folder_key LIKE $2', [folderKey, `${folderKey}/%`]);
    await client.query('COMMIT');
    return { folderId: folderKey };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  findGalleryItems,
  findGalleryItemById,
  updateGalleryItem,
  findDistinctFolders,
  findAllGalleryFolders,
  createGalleryFolder,
  renameGalleryFolder,
  updateGalleryFolderEventDate,
  updateGalleryFolderMetadata,
  deleteGalleryFolder,
  createGalleryItem,
  deleteGalleryItemById,
  findGalleryComments,
  createGalleryComment,
  deleteGalleryComment,
};
