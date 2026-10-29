const crypto = require('crypto');
const { can } = require('../config/accessPolicy');
const { findRolePermissions } = require('../models/userModel');
const sharp = require('sharp');
const storage = require('../storage');
const {
  findGalleryItems,
  findGalleryItemById,
  updateGalleryItem,
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
} = require('../models/galleryModel');
const { recordDownload } = require('../models/dashboardModel');

const buildKey = (prefix, originalName) => {
  const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const hash = crypto.randomUUID();
  const dateSegment = new Date().toISOString().slice(0, 10);
  return `${prefix}/${dateSegment}/${hash}${ext}`;
};

const withUploaderName = (item) => {
  if (!item) return item;
  return {
    ...item,
    uploaded_by_id: item.uploaded_by,
    uploaded_by: item.uploaded_by_name || item.uploaded_by_username || item.uploaded_by || null,
  };
};

const calculateChecksum = (buffer) => {
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

const isImageMimeType = (mimeType) => {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
};

const isValidEventDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const processUploadFile = async (file, folder_id, title, description, author, event_date, uploaded_by) => {
  const originalFilename = file.originalname;
  const mimeType = file.mimetype;
  const sizeBytes = file.size;
  const checksum = calculateChecksum(file.buffer);
  const storageKey = buildKey('gallery', originalFilename);
  let thumbnailKey = null;

  await storage.upload(storageKey, file.buffer, mimeType);

  if (isImageMimeType(mimeType)) {
    thumbnailKey = buildKey('thumbnails/gallery', originalFilename);
    const thumbnailBuffer = await sharp(file.buffer)
      .resize(300, 300, {
        fit: 'cover',
        position: sharp.strategy.entropy,
      })
      .webp({ quality: 80 })
      .toBuffer();
    await storage.upload(thumbnailKey, thumbnailBuffer, 'image/webp');
  }

  return await createGalleryItem({
    title: title || originalFilename,
    description: description || null,
    author: author || null,
    event_date: event_date || null,
    original_filename: originalFilename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    storage_key: storageKey,
    thumbnail_key: thumbnailKey,
    folder_id: folder_id || null,
    checksum,
    uploaded_by,
  });
};

const ensureFolderPathExists = async (folderKey) => {
  if (!folderKey) {
    return null;
  }

  const segments = folderKey.split('/').filter(Boolean);
  let currentKey = '';
  let parentFolderKey = null;

  for (const segment of segments) {
    currentKey = currentKey ? `${currentKey}/${segment}` : segment;
    await createGalleryFolder({
      folder_key: currentKey,
      name: segment,
      description: null,
      parent_folder_key: parentFolderKey,
    });
    parentFolderKey = currentKey;
  }

  return currentKey;
};

const getGalleryItems = async (req, res, next) => {
  try {
    const { page, pageSize, limit, offset, folderId, search, sortBy, order } = req.query;
    const resolvedPage = Math.max(1, parseInt(page, 10) || 1);
    const resolvedPageSize = Math.max(1, parseInt(pageSize, 10) || parseInt(limit, 10) || 50);
    const resolvedOffset = Number.isFinite(parseInt(offset, 10))
      ? Math.max(0, parseInt(offset, 10))
      : (resolvedPage - 1) * resolvedPageSize;

    const { items, totalCount } = await findGalleryItems({
      page: resolvedPage,
      pageSize: resolvedPageSize,
      offset: resolvedOffset,
      folderId,
      search,
      sortBy,
      order,
    });

    res.json({ items: items.map(withUploaderName), totalCount, page: resolvedPage, pageSize: resolvedPageSize });
  } catch (error) {
    next(error);
  }
};

const getGalleryItemById = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: 'Gallery item not found.' });
    }
    res.json(withUploaderName(await findGalleryItemById(item.id)));
  } catch (error) {
    next(error);
  }
};

const getGalleryItemComments = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Gallery item not found.' });
    res.json(await findGalleryComments(req.params.id));
  } catch (error) {
    next(error);
  }
};

const addGalleryItemComment = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    const comment = String(req.body?.comment || '').trim();
    if (!item) return res.status(404).json({ message: 'Gallery item not found.' });
    if (!comment) return res.status(400).json({ message: 'Comment cannot be empty.' });
    if (comment.length > 2000) return res.status(400).json({ message: 'Comment is too long.' });
    const created = await createGalleryComment(req.params.id, req.user.id, comment);
    const comments = await findGalleryComments(req.params.id);
    res.status(201).json(comments.find((entry) => String(entry.id) === String(created.id)) || created);
  } catch (error) {
    next(error);
  }
};

const removeGalleryItemComment = async (req, res, next) => {
  try {
    const deleted = await deleteGalleryComment(req.params.commentId, req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ message: 'Comment not found.' });
    res.json({ id: deleted.id });
  } catch (error) {
    next(error);
  }
};

const updateGalleryItemDetails = async (req, res, next) => {
  try {
    const existing = await findGalleryItemById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Gallery item not found.' });

    const { title, description, author, folder_id } = req.body || {};
    if (title !== undefined && !String(title || '').trim()) return res.status(400).json({ message: 'Title cannot be empty.' });

    const item = await updateGalleryItem(req.params.id, {
      title: title === undefined ? undefined : String(title).trim(),
      description: description === undefined ? undefined : String(description),
      author: author === undefined ? undefined : String(author).trim(),
      folder_id: folder_id === undefined ? undefined : folder_id || null,
    });
    res.json(withUploaderName(item));
  } catch (error) {
    next(error);
  }
};

const updateGalleryItemsDetails = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const { title, description, author, folder_id } = req.body || {};
    if (!ids.length) return res.status(400).json({ message: 'At least one gallery item id is required.' });
    if (title === undefined && description === undefined && author === undefined && folder_id === undefined) {
      return res.status(400).json({ message: 'At least one field is required.' });
    }
    if (folder_id) await ensureFolderPathExists(folder_id);
    const updated = [];
    for (const id of ids) {
      const item = await findGalleryItemById(id);
      if (!item) continue;
      updated.push(withUploaderName(await updateGalleryItem(id, {
        title: title === undefined ? undefined : String(title).trim(),
        description: description === undefined ? undefined : String(description),
        author: author === undefined ? undefined : String(author).trim(),
        folder_id: folder_id === undefined ? undefined : folder_id || null,
      })));
    }
    res.json({ count: updated.length, items: updated });
  } catch (error) {
    next(error);
  }
};

const uploadGalleryItem = async (req, res, next) => {
  try {
    const { title, description, author, folder_id } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: 'File is required.' });
    }

    if (folder_id) {
      await ensureFolderPathExists(folder_id);
    }

    const item = await processUploadFile(file, folder_id, title, description, author, null, req.user?.id || null);
    res.status(201).json(withUploaderName(await findGalleryItemById(item.id)));
  } catch (error) {
    next(error);
  }
};

const uploadMultipleGalleryItems = async (req, res, next) => {
  try {
    const { folder_id, title, description, author } = req.body;
    const files = req.files;
    const relativePaths = Array.isArray(req.body.relativePaths)
      ? req.body.relativePaths
      : req.body.relativePaths
      ? [req.body.relativePaths]
      : [];

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ message: 'At least one file is required.' });
    }
    if (folder_id) {
      await ensureFolderPathExists(folder_id);
    }

    const uploadedItems = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const relativePath = relativePaths[index] || file.name;
      const inferredFolderId =
        folder_id || (relativePath.includes('/') ? relativePath.substring(0, relativePath.lastIndexOf('/')) : null);

      if (inferredFolderId) {
        await ensureFolderPathExists(inferredFolderId);
      }

      const item = await processUploadFile(file, inferredFolderId, title, description, author, null, req.user?.id || null);
      uploadedItems.push(withUploaderName(await findGalleryItemById(item.id)));
    }

    res.status(201).json({ count: uploadedItems.length, items: uploadedItems });
  } catch (error) {
    next(error);
  }
};

const getGalleryItemThumbnail = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    if (!item || !item.thumbnail_key) {
      return res.status(404).json({ message: 'Thumbnail not found.' });
    }

    if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
      const stream = storage.getStream(item.thumbnail_key);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      stream.pipe(res);
      return;
    }

    const url = await storage.getUrl(item.thumbnail_key);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

const downloadGalleryItem = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    if (!item || !item.storage_key) {
      return res.status(404).json({ message: 'Gallery item not found.' });
    }
    // Regular users download only when their role allows it (Administration → role permissions).
    if (!can(req.user?.access_level, 'gallery.manage')) {
      const rolePermissions = await findRolePermissions(String(req.user?.role || '').trim() || 'user');
      if (rolePermissions.download === false) {
        return res.status(403).json({ message: 'Downloads are turned off for your role.', code: 'FORBIDDEN' });
      }
    }
    await recordDownload(req.user.id, 'gallery', item.id);

    if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
      const stream = storage.getStream(item.storage_key);
      res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${item.original_filename}"`);
      stream.pipe(res);
      return;
    }

    const url = await storage.getUrl(item.storage_key);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

const createGalleryFolderHandler = async (req, res, next) => {
  try {
    let { folder_key, name, description, parent_folder_key, event_date, category } = req.body;
    if (!folder_key && !name) {
      return res.status(400).json({ message: 'folder_key or name is required.' });
    }

    const folderName = String(name || folder_key).trim();
    if (!folderName || /[\\/:*?"<>|]/.test(folderName)) {
      return res.status(400).json({ message: 'A valid folder name is required.' });
    }
    if (!folder_key) {
      folder_key = parent_folder_key ? `${parent_folder_key}/${folderName}` : folderName;
    }

    const parentKey =
      parent_folder_key || (folder_key.includes('/') ? folder_key.slice(0, folder_key.lastIndexOf('/')) : null);
    if (parentKey) {
      await ensureFolderPathExists(parentKey);
    }

    const folder = await createGalleryFolder({
      folder_key,
      name: folderName,
      description,
      parent_folder_key: parentKey,
      event_date: event_date || null,
      category: category || null,
      rejectDuplicate: true,
    });
    res.status(201).json(folder);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'A folder with that name already exists.' });
    }
    next(error);
  }
};

const updateGalleryFolderEventDateHandler = async (req, res, next) => {
  try {
    const eventDate = String(req.body?.event_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ message: 'A valid event date is required.' });
    }
    const folder = await updateGalleryFolderEventDate(req.params.folderKey, eventDate);
    if (!folder) return res.status(404).json({ message: 'Folder not found.' });
    res.json(folder);
  } catch (error) {
    next(error);
  }
};

const updateGalleryFolderMetadataHandler = async (req, res, next) => {
  try {
    const eventDate = String(req.body?.event_date || '');
    const category = String(req.body?.category || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !category) {
      return res.status(400).json({ message: 'A valid event date and category are required.' });
    }
    const folder = await updateGalleryFolderMetadata(req.params.folderKey, eventDate, category);
    if (!folder) return res.status(404).json({ message: 'Folder not found.' });
    res.json(folder);
  } catch (error) {
    next(error);
  }
};

const getGalleryFolders = async (req, res, next) => {
  try {
    const folders = await findAllGalleryFolders();
    res.json(folders);
  } catch (error) {
    next(error);
  }
};

const renameGalleryFolderHandler = async (req, res, next) => {
  try {
    const folderKey = String(req.params.folderKey || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!folderKey || !name || /[\\/:*?"<>|]/.test(name)) {
      return res.status(400).json({ message: 'A valid folder name is required.' });
    }
    const folder = await renameGalleryFolder(folderKey, name);
    if (!folder) return res.status(404).json({ message: 'Folder not found.' });
    res.json(folder);
  } catch (error) {
    next(error);
  }
};

const deleteGalleryFolderHandler = async (req, res, next) => {
  try {
    const folderKey = String(req.params.folderKey || '').trim();
    const folderItems = await findGalleryItems({ page: 1, pageSize: 100000, folderId: folderKey });
    for (const item of folderItems.items || []) {
      if (item.storage_key) await storage.delete(item.storage_key);
      if (item.thumbnail_key) await storage.delete(item.thumbnail_key);
    }
    const deleted = await deleteGalleryFolder(folderKey);
    if (!deleted) return res.status(404).json({ message: 'Folder not found.' });
    res.json({ message: 'Folder deleted successfully.' });
  } catch (error) {
    next(error);
  }
};

const deleteGalleryItem = async (req, res, next) => {
  try {
    const item = await findGalleryItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: 'Gallery item not found.' });
    }

    if (item.storage_key) {
      await storage.delete(item.storage_key);
    }
    if (item.thumbnail_key) {
      await storage.delete(item.thumbnail_key);
    }
    await deleteGalleryItemById(req.params.id);
    res.json({ message: 'Gallery item deleted successfully.' });
  } catch (error) {
    next(error);
  }
};

const deleteGalleryItems = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const normalizedIds = ids.filter(Boolean);

    if (!normalizedIds.length) {
      return res.status(400).json({ message: 'At least one gallery item id is required.' });
    }

    const deletedIds = [];
    const missingIds = [];

    for (const id of normalizedIds) {
      const item = await findGalleryItemById(id);
      if (!item) {
        missingIds.push(id);
        continue;
      }

      if (item.storage_key) {
        await storage.delete(item.storage_key);
      }
      if (item.thumbnail_key) {
        await storage.delete(item.thumbnail_key);
      }
      await deleteGalleryItemById(id);
      deletedIds.push(id);
    }

    res.json({
      deletedIds,
      missingIds,
      message: deletedIds.length ? 'Gallery items deleted successfully.' : 'No gallery items deleted.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadGalleryItem,
  getGalleryItems,
  getGalleryFolders,
  updateGalleryFolderEventDateHandler,
  updateGalleryFolderMetadataHandler,
  createGalleryFolderHandler,
  renameGalleryFolderHandler,
  deleteGalleryFolderHandler,
  uploadMultipleGalleryItems,
  getGalleryItemById,
  getGalleryItemComments,
  addGalleryItemComment,
  removeGalleryItemComment,
  updateGalleryItemDetails,
  updateGalleryItemsDetails,
  getGalleryItemThumbnail,
  downloadGalleryItem,
  deleteGalleryItem,
  deleteGalleryItems,
};
