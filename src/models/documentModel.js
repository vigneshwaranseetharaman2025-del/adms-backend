const pool = require('../config/db');

const ALLOWED_SORT_FIELDS = new Set(['title', 'uploaded_at', 'size_bytes', 'mime_type']);

/**
 * Whether a regular user may view / download document d. A per-document permission
 * (document_permissions) wins; otherwise the user's role permission (role_permissions);
 * otherwise allowed. `param` is the SQL placeholder holding the user id, or null for
 * Admins and Superadmins, who may open everything.
 */
const accessExpr = (column, param) => (param
  ? `COALESCE(
       (SELECT dp.${column} FROM document_permissions dp WHERE dp.document_id = d.id AND dp.user_id = ${param}),
       (SELECT rp.${column} FROM users au JOIN role_permissions rp ON rp.role = COALESCE(NULLIF(TRIM(au.role), ''), 'user') WHERE au.id = ${param}),
       TRUE)`
  : 'TRUE');
const canViewExpr = (param) => accessExpr('view', param);
const canDownloadExpr = (param) => (param ? `(${accessExpr('view', param)} AND ${accessExpr('download', param)})` : 'TRUE');

const findDocuments = async ({ page = 1, pageSize, limit = 50, offset, folderId, search, sortBy = 'uploaded_at', order = 'desc', userId = null, accessUserId = null }) => {
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

  let accessParam = null;
  if (accessUserId) {
    values.push(accessUserId);
    accessParam = `$${values.length}::int`;
    queryParts.push(canViewExpr(accessParam));
  }

  const whereClause = queryParts.length ? `WHERE ${queryParts.join(' AND ')}` : '';
  const safeSortBy = ALLOWED_SORT_FIELDS.has(sortBy) ? sortBy : 'uploaded_at';
  const safeOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  values.push(userId);
  values.push(resolvedPageSize);
  values.push(resolvedOffset);

  const query = `
    SELECT d.*, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username,
      (SELECT COUNT(*) FROM document_acknowledgements da WHERE da.document_id = d.id) AS acknowledgement_count,
      (SELECT signed_at FROM document_acknowledgements da WHERE da.document_id = d.id AND da.user_id = $${values.length - 2}) AS acknowledged_at,
      (SELECT signature_data FROM document_acknowledgements da WHERE da.document_id = d.id AND da.user_id = $${values.length - 2}) AS signature_data,
      ${canDownloadExpr(accessParam)} AS can_download
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    ${whereClause}
    ORDER BY d.${safeSortBy} ${safeOrder}, d.id ASC
    LIMIT $${values.length - 1}
    OFFSET $${values.length}
  `;

  const countValues = values.slice(0, -3);
  const countQuery = `SELECT COUNT(*) AS total_count FROM documents d ${whereClause}`;

  const [documentsResult, countResult] = await Promise.all([
    pool.query(query, values),
    pool.query(countQuery, countValues),
  ]);

  return {
    documents: documentsResult.rows,
    totalCount: parseInt(countResult.rows[0]?.total_count || '0', 10),
  };
};

const findDocumentById = async (id, userId = null, accessUserId = null) => {
  const accessParam = accessUserId ? '$3::int' : null;
  const result = await pool.query(
    `SELECT d.*, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username,
      (SELECT signed_at FROM document_acknowledgements da WHERE da.document_id = d.id AND da.user_id = $2) AS acknowledged_at,
      (SELECT signature_data FROM document_acknowledgements da WHERE da.document_id = d.id AND da.user_id = $2) AS signature_data,
      ${canViewExpr(accessParam)} AS can_view,
      ${canDownloadExpr(accessParam)} AS can_download
     FROM documents d
     LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.id = $1`,
      accessUserId ? [id, userId, accessUserId] : [id, userId]
  );
  return result.rows[0] || null;
};

const updateDocument = async (id, { title, description, author, folder_id, acknowledgement_required }) => {
  const result = await pool.query(
    `UPDATE documents
    SET title = COALESCE($1, title), description = COALESCE($2, description),
      author = COALESCE($3, author), folder_id = CASE WHEN $4 THEN $5 ELSE folder_id END,
      updated_at = NOW(), edited_at = NOW(),
      acknowledgement_required = COALESCE($6, acknowledgement_required)
    WHERE id = $7
     RETURNING *`,
    [title ?? null, description ?? null, author ?? null, folder_id !== undefined, folder_id ?? null, acknowledgement_required ?? null, id]
  );
  return result.rows[0] || null;
};

const findDistinctFolders = async () => {
  const result = await pool.query(
    `SELECT folder_id, COUNT(*) AS document_count
     FROM documents
     WHERE folder_id IS NOT NULL
     GROUP BY folder_id
     ORDER BY document_count DESC`
  );
  return result.rows.map((row) => ({ folderId: row.folder_id, count: parseInt(row.document_count, 10) }));
};

const createDocument = async ({ title, description, author, original_filename, mime_type, size_bytes, storage_key, thumbnail_key, folder_id, checksum, uploaded_by, acknowledgement_required = false }) => {
  const result = await pool.query(
    `INSERT INTO documents (
      title,
      description,
      author,
      original_filename,
      mime_type,
      size_bytes,
      storage_key,
      thumbnail_key,
      folder_id,
      checksum,
      uploaded_by,
      acknowledgement_required
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [title, description, author, original_filename, mime_type, size_bytes, storage_key, thumbnail_key, folder_id, checksum, uploaded_by, acknowledgement_required]
  );
  return result.rows[0];
};

const acknowledgeDocument = async (documentId, userId, signatureData) => {
  const result = await pool.query(
    `INSERT INTO document_acknowledgements (document_id, user_id, signature_data) VALUES ($1, $2, $3)
     ON CONFLICT (document_id, user_id) DO UPDATE SET signed_at = NOW(), signature_data = EXCLUDED.signature_data
     RETURNING signed_at, signature_data`,
    [documentId, userId, signatureData]
  );
  return result.rows[0];
};

const findDocumentAcknowledgements = async (documentId) => {
  const result = await pool.query(
    `SELECT da.user_id, da.signed_at, u.full_name, u.username, u.email
     FROM document_acknowledgements da JOIN users u ON u.id = da.user_id
     WHERE da.document_id = $1 ORDER BY da.signed_at DESC`, [documentId]
  );
  return result.rows;
};

const findDocumentPermissions = async (documentId) => {
  const result = await pool.query(
    `SELECT dp.*, u.full_name, u.username, u.email FROM document_permissions dp
     JOIN users u ON u.id = dp.user_id WHERE dp.document_id = $1 ORDER BY u.full_name, u.username`, [documentId]
  );
  return result.rows;
};

const upsertDocumentPermission = async (documentId, permission) => {
  const result = await pool.query(
    `INSERT INTO document_permissions (document_id, user_id, view, download, upload, edit, delete_permission, share, copy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (document_id, user_id) DO UPDATE SET view=$3, download=$4, upload=$5, edit=$6, delete_permission=$7, share=$8, copy=$9
     RETURNING *`,
    [documentId, permission.user_id, permission.view, permission.download, permission.upload, permission.edit, permission.delete_permission, permission.share, permission.copy]
  );
  return result.rows[0];
};

const deleteDocumentById = async (id) => {
  const result = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
  return result.rows[0] || null;
};

const createFolder = async ({ folder_key, name, description, parent_folder_key = null, rejectDuplicate = false }) => {
  const result = await pool.query(
    `INSERT INTO folders (folder_key, name, description, parent_folder_key)
     VALUES ($1, $2, $3, $4)
     ${rejectDuplicate ? '' : 'ON CONFLICT (folder_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, parent_folder_key = EXCLUDED.parent_folder_key'}
     RETURNING *`,
    [folder_key, name, description, parent_folder_key]
  );
  return result.rows[0];
};

const findAllFolders = async () => {
  const result = await pool.query(
    `SELECT f.folder_key, f.name, f.description, f.parent_folder_key, COUNT(d.id) AS document_count
     FROM folders f
     LEFT JOIN documents d ON d.folder_id = f.folder_key
     GROUP BY f.folder_key, f.name, f.description, f.parent_folder_key
     ORDER BY f.folder_key ASC`
  );
  return result.rows.map((row) => ({
    folderId: row.folder_key,
    name: row.name,
    description: row.description,
    parentFolderId: row.parent_folder_key,
    path: row.folder_key,
    count: parseInt(row.document_count, 10),
  }));
};

const renameFolder = async (folderKey, newName) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const folderResult = await client.query(
      'SELECT folder_key, parent_folder_key FROM folders WHERE folder_key = $1 FOR UPDATE',
      [folderKey]
    );
    if (!folderResult.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const folder = folderResult.rows[0];
    const renamedKey = folder.parent_folder_key ? `${folder.parent_folder_key}/${newName}` : newName;
    if (renamedKey !== folderKey) {
      const conflict = await client.query('SELECT 1 FROM folders WHERE folder_key = $1', [renamedKey]);
      if (conflict.rows[0]) {
        const error = new Error('A folder with that name already exists.');
        error.status = 409;
        throw error;
      }
    }

    const descendants = await client.query(
      'SELECT folder_key FROM folders WHERE folder_key = $1 OR folder_key LIKE $2 ORDER BY LENGTH(folder_key) DESC',
      [folderKey, `${folderKey}/%`]
    );
    for (const descendant of descendants.rows) {
      const nextKey = descendant.folder_key === folderKey
        ? renamedKey
        : `${renamedKey}${descendant.folder_key.slice(folderKey.length)}`;
      await client.query(
        `UPDATE folders
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
      'UPDATE documents SET folder_id = ($1::varchar || SUBSTRING(folder_id FROM $2::integer))::varchar WHERE folder_id = $3::varchar OR folder_id LIKE $4::varchar',
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

const deleteFolder = async (folderKey) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT folder_key FROM folders WHERE folder_key = $1 OR folder_key LIKE $2',
      [folderKey, `${folderKey}/%`]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM documents WHERE folder_id = $1 OR folder_id LIKE $2', [folderKey, `${folderKey}/%`]);
    await client.query('DELETE FROM folders WHERE folder_key = $1 OR folder_key LIKE $2', [folderKey, `${folderKey}/%`]);
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
  canViewExpr,
  canDownloadExpr,
  findDocuments,
  findDocumentById,
  updateDocument,
  findDistinctFolders,
  findAllFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  createDocument,
  acknowledgeDocument,
  findDocumentAcknowledgements,
  findDocumentPermissions,
  upsertDocumentPermission,
  deleteDocumentById,
};
