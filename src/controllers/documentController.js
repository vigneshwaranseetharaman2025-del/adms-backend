const crypto = require('crypto');
const sharp = require('sharp');
const storage = require('../storage');
const {
  findDocuments,
  findDocumentById,
  updateDocument,
  findAllFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  createDocument,
  deleteDocumentById,
  acknowledgeDocument: saveAcknowledgement,
  findDocumentAcknowledgements,
  findDocumentPermissions,
  upsertDocumentPermission,
} = require('../models/documentModel');
const { findUserById } = require('../models/userModel');
const { recordDownload } = require('../models/dashboardModel');

// Shared SMTP transport: picks the right TLS mode for SMTP_PORT (see config/mailer.js).
const { mailer } = require('../config/mailer');

const { can } = require('../config/accessPolicy');

const isAdmin = (req) => req.user?.is_admin === true;
// Admins and Superadmins see every document; others only what their permissions allow.
const accessUserIdFor = (req) => (can(req.user?.access_level, 'documents.manage') ? null : req.user?.id);
// The raw storage key lets a file be opened from /files/ and shared in chat, so it is only
// returned to people who may download the document.
const forViewer = (document) => {
  if (!document) return document;
  const { can_view: _canView, ...rest } = document;
  return rest.can_download === false ? { ...rest, storage_key: null } : rest;
};
const requireAdmin = (req, res) => {
  if (!isAdmin(req)) {
    res.status(403).json({ message: 'Administrator access is required.' });
    return false;
  }
  return true;
};

const buildKey = (prefix, originalName) => {
  const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const hash = crypto.randomUUID();
  const dateSegment = new Date().toISOString().slice(0, 10);
  return `${prefix}/${dateSegment}/${hash}${ext}`;
};

const withUploaderName = (document) => {
  if (!document) return document;
  return {
    ...document,
    uploaded_by_id: document.uploaded_by,
    uploaded_by: document.uploaded_by_name || document.uploaded_by_username || document.uploaded_by || null,
  };
};

const calculateChecksum = (buffer) => {
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

const isImageMimeType = (mimeType) => {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
};

const processUploadFile = async (file, folder_id, title, description, author, uploaded_by, acknowledgement_required) => {
  const originalFilename = file.originalname;
  const mimeType = file.mimetype;
  const sizeBytes = file.size;
  const checksum = calculateChecksum(file.buffer);
  const storageKey = buildKey('documents', originalFilename);
  let thumbnailKey = null;

  await storage.upload(storageKey, file.buffer, mimeType);

  if (isImageMimeType(mimeType)) {
    thumbnailKey = buildKey('thumbnails', originalFilename);
    const thumbnailBuffer = await sharp(file.buffer)
      .resize(150, 150, {
        fit: 'cover',
        position: sharp.strategy.entropy,
      })
      .webp({ quality: 80 })
      .toBuffer();
    await storage.upload(thumbnailKey, thumbnailBuffer, 'image/webp');
  }

  return await createDocument({
    title: title || originalFilename,
    description: description || null,
    author: author || null,
    original_filename: originalFilename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    storage_key: storageKey,
    thumbnail_key: thumbnailKey,
    folder_id: folder_id || null,
    checksum,
    uploaded_by,
    acknowledgement_required,
  });
};

const getAllDocuments = async (req, res, next) => {
  try {
    const { page, pageSize, limit, offset, folderId, search, sortBy, order } = req.query;
    const resolvedPage = Math.max(1, parseInt(page, 10) || 1);
    const resolvedPageSize = Math.max(1, parseInt(pageSize, 10) || parseInt(limit, 10) || 50);
    const resolvedOffset = Number.isFinite(parseInt(offset, 10))
      ? Math.max(0, parseInt(offset, 10))
      : (resolvedPage - 1) * resolvedPageSize;

    const { documents, totalCount } = await findDocuments({
      page: resolvedPage,
      pageSize: resolvedPageSize,
      offset: resolvedOffset,
      folderId,
      search,
      sortBy,
      order,
      userId: req.user?.id,
      accessUserId: accessUserIdFor(req),
    });

    res.json({ documents: documents.map((document) => forViewer(withUploaderName(document))), totalCount, page: resolvedPage, pageSize: resolvedPageSize });
  } catch (error) {
    next(error);
  }
};

const getDocumentById = async (req, res, next) => {
  try {
    const document = await findDocumentById(req.params.id, req.user?.id, accessUserIdFor(req));
    if (!document || document.can_view === false) {
      return res.status(404).json({ message: 'Document not found.' });
    }
    res.json(forViewer(withUploaderName(document)));
  } catch (error) {
    next(error);
  }
};

const updateDocumentDetails = async (req, res, next) => {
  try {
    const existing = await findDocumentById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Document not found.' });

    const { title, description, author, folder_id, acknowledgement_required } = req.body || {};
    if (title !== undefined && !String(title || '').trim()) return res.status(400).json({ message: 'Title cannot be empty.' });

    const document = await updateDocument(req.params.id, {
      title: title === undefined ? undefined : String(title).trim(),
      description: description === undefined ? undefined : String(description),
      author: author === undefined ? undefined : String(author).trim(),
      folder_id: folder_id === undefined ? undefined : folder_id || null,
      acknowledgement_required: acknowledgement_required === undefined ? undefined : acknowledgement_required === true || acknowledgement_required === 'true',
    });
    res.json(withUploaderName(document));
  } catch (error) {
    next(error);
  }
};

const updateDocumentsDetails = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const { title, description, author, folder_id, acknowledgement_required } = req.body || {};
    if (!ids.length) return res.status(400).json({ message: 'At least one document id is required.' });
    if (title === undefined && description === undefined && author === undefined && folder_id === undefined && acknowledgement_required === undefined) {
      return res.status(400).json({ message: 'At least one field is required.' });
    }
    if (folder_id) await ensureFolderPathExists(folder_id);
    const updated = [];
    for (const id of ids) {
      const document = await findDocumentById(id);
      if (!document) continue;
      updated.push(withUploaderName(await updateDocument(id, {
        title: title === undefined ? undefined : String(title).trim(),
        description: description === undefined ? undefined : String(description),
        author: author === undefined ? undefined : String(author).trim(),
        folder_id: folder_id === undefined ? undefined : folder_id || null,
        acknowledgement_required: acknowledgement_required === undefined ? undefined : Boolean(acknowledgement_required),
      })));
    }
    res.json({ count: updated.length, documents: updated });
  } catch (error) {
    next(error);
  }
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
    await createFolder({
      folder_key: currentKey,
      name: segment,
      description: null,
      parent_folder_key: parentFolderKey,
    });
    parentFolderKey = currentKey;
  }

  return currentKey;
};

const uploadDocument = async (req, res, next) => {
  try {
    const { title, description, author, folder_id, acknowledgement_required } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: 'File is required.' });
    }

    if (folder_id) {
      await ensureFolderPathExists(folder_id);
    }

    const document = await processUploadFile(file, folder_id, title, description, author, req.user?.id || null, acknowledgement_required === 'true');
    res.status(201).json(withUploaderName(await findDocumentById(document.id, req.user?.id)));
  } catch (error) {
    next(error);
  }
};

const uploadMultipleDocuments = async (req, res, next) => {
  try {
    const { folder_id, title, description, author, acknowledgement_required } = req.body;
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

    const uploadedDocuments = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const relativePath = relativePaths[index] || file.name;
      const inferredFolderId =
        folder_id || (relativePath.includes('/') ? relativePath.substring(0, relativePath.lastIndexOf('/')) : null);

      if (inferredFolderId) {
        await ensureFolderPathExists(inferredFolderId);
      }

      const document = await processUploadFile(file, inferredFolderId, title, description, author, req.user?.id || null, acknowledgement_required === 'true');
      uploadedDocuments.push(withUploaderName(await findDocumentById(document.id, req.user?.id)));
    }

    res.status(201).json({ count: uploadedDocuments.length, documents: uploadedDocuments });
  } catch (error) {
    next(error);
  }
};

const getDocumentThumbnail = async (req, res, next) => {
  try {
    const document = await findDocumentById(req.params.id, null, accessUserIdFor(req));
    if (!document || !document.thumbnail_key || document.can_view === false) {
      return res.status(404).json({ message: 'Thumbnail not found.' });
    }

    if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
      const stream = storage.getStream(document.thumbnail_key);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      stream.pipe(res);
      return;
    }

    const url = await storage.getUrl(document.thumbnail_key);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

const downloadDocument = async (req, res, next) => {
  try {
    const document = await findDocumentById(req.params.id, null, accessUserIdFor(req));
    if (!document || !document.storage_key || document.can_view === false) {
      return res.status(404).json({ message: 'Document not found.' });
    }
    // ?preview=1 opens the file for viewing: needs view permission only and is not counted
    // as a download. A real download needs download permission.
    const isPreview = req.query.preview === '1' || req.query.preview === 'true';
    if (!isPreview && document.can_download === false) {
      return res.status(403).json({ message: 'You do not have permission to download this document.', code: 'FORBIDDEN' });
    }
    if (!isPreview) await recordDownload(req.user.id, 'document', document.id);

    if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
      const stream = storage.getStream(document.storage_key);
      res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `${isPreview ? 'inline' : 'attachment'}; filename="${document.original_filename}"`);
      stream.pipe(res);
      return;
    }

    const url = await storage.getUrl(document.storage_key);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

const createDocumentFolder = async (req, res, next) => {
  try {
    let { folder_key, name, description, parent_folder_key } = req.body;
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

    const folder = await createFolder({
      folder_key,
      name: folderName,
      description,
      parent_folder_key: parentKey,
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

const getDocumentFolders = async (req, res, next) => {
  try {
    const folders = await findAllFolders();
    res.json(folders);
  } catch (error) {
    next(error);
  }
};

const renameDocumentFolder = async (req, res, next) => {
  try {
    const folderKey = String(req.params.folderKey || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!folderKey || !name || /[\\/:*?"<>|]/.test(name)) {
      return res.status(400).json({ message: 'A valid folder name is required.' });
    }
    const folder = await renameFolder(folderKey, name);
    if (!folder) return res.status(404).json({ message: 'Folder not found.' });
    res.json(folder);
  } catch (error) {
    next(error);
  }
};

const deleteDocumentFolder = async (req, res, next) => {
  try {
    const folderKey = String(req.params.folderKey || '').trim();
    const folderDocuments = await findDocuments({ page: 1, pageSize: 100000, folderId: folderKey });
    for (const document of folderDocuments.documents || []) {
      if (document.storage_key) await storage.delete(document.storage_key);
      if (document.thumbnail_key) await storage.delete(document.thumbnail_key);
    }
    const deleted = await deleteFolder(folderKey);
    if (!deleted) return res.status(404).json({ message: 'Folder not found.' });
    res.json({ message: 'Folder deleted successfully.' });
  } catch (error) {
    next(error);
  }
};

const deleteDocument = async (req, res, next) => {
  try {
    const document = await findDocumentById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    if (document.storage_key) {
      await storage.delete(document.storage_key);
    }
    if (document.thumbnail_key) {
      await storage.delete(document.thumbnail_key);
    }
    await deleteDocumentById(req.params.id);
    res.json({ message: 'Document deleted successfully.' });
  } catch (error) {
    next(error);
  }
};

const deleteDocuments = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const normalizedIds = ids.filter(Boolean);

    if (!normalizedIds.length) {
      return res.status(400).json({ message: 'At least one document id is required.' });
    }

    const deletedIds = [];
    const missingIds = [];

    for (const id of normalizedIds) {
      const document = await findDocumentById(id);
      if (!document) {
        missingIds.push(id);
        continue;
      }

      if (document.storage_key) {
        await storage.delete(document.storage_key);
      }
      if (document.thumbnail_key) {
        await storage.delete(document.thumbnail_key);
      }
      await deleteDocumentById(id);
      deletedIds.push(id);
    }

    res.json({
      deletedIds,
      missingIds,
      message: deletedIds.length ? 'Documents deleted successfully.' : 'No documents deleted.',
    });
  } catch (error) {
    next(error);
  }
};

const acknowledgeDocument = async (req, res, next) => {
  try {
    const document = await findDocumentById(req.params.id, req.user?.id, accessUserIdFor(req));
    if (!document || document.can_view === false) return res.status(404).json({ message: 'Document not found.' });
    if (!document.acknowledgement_required) return res.status(400).json({ message: 'This document does not require acknowledgement.' });
    const { signatureData } = req.body || {};
    if (typeof signatureData !== 'string' || !signatureData.startsWith('data:image/png;base64,') || signatureData.length > 2_000_000) {
      return res.status(400).json({ message: 'A valid signature is required.' });
    }
    const acknowledgement = await saveAcknowledgement(req.params.id, req.user.id, signatureData);
    const user = await findUserById(req.user.id);
    const adminEmail = process.env.ADMIN_EMAIL;
    if ((user?.email || adminEmail) && process.env.SMTP_USERNAME) {
      const signerName = user.full_name || user.username || 'User';
      const signedAt = new Date(acknowledgement.signed_at).toLocaleString();
      const signatureMarkup = `
        <div style="margin:22px 0;padding:16px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px">
          <strong style="display:block;margin-bottom:10px">Signature</strong>
          <img src="${signatureData}" alt="${signerName}'s signature" style="display:block;max-width:100%;height:100px;object-fit:contain;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px" />
        </div>`;
      const emailShell = (title, body) => `
        <div style="margin:0;background:#f4f6fb;padding:32px 16px;font-family:Arial,sans-serif;color:#1f2937">
          <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
            <div style="background:#4b0bd6;padding:24px 28px;color:#ffffff"><h1 style="margin:0;font-size:22px">${title}</h1></div>
            <div style="padding:28px">${body}</div>
          </div>
        </div>`;

      if (user?.email) {
        await mailer.sendMail({
          from: process.env.SMTP_USERNAME,
          to: user.email,
          subject: `Your acknowledgement was recorded: ${document.title}`,
          html: emailShell('Acknowledgement successful', `
            <p style="font-size:16px">Hello ${signerName},</p>
            <p>Thank you. You have successfully reviewed, acknowledged, and signed the following document:</p>
            <div style="margin:22px 0;padding:16px;background:#f8fafc;border-left:4px solid #16a34a"><strong>${document.title}</strong><br/><span style="color:#64748b;font-size:13px">Signed on ${signedAt}</span></div>
            ${signatureMarkup}
            <p style="color:#475569">Your sign-off has been securely recorded in ADMS. Please retain this email for your records.</p>
            <p style="margin-top:28px">Thank you,<br/><strong>ADMS Administration</strong></p>`),
        });
      }

      if (adminEmail) {
        await mailer.sendMail({
          from: process.env.SMTP_USERNAME,
          to: adminEmail,
          subject: `Policy signed: ${document.title}`,
          html: emailShell('Policy sign-off notification', `
            <p style="font-size:16px">Hello Administrator,</p>
            <p>A user has completed the acknowledgement and sign-off for a document.</p>
            <table style="width:100%;border-collapse:collapse;margin:22px 0">
              <tr><td style="padding:10px;background:#f8fafc;color:#64748b">Document</td><td style="padding:10px;background:#f8fafc"><strong>${document.title}</strong></td></tr>
              <tr><td style="padding:10px;border-top:1px solid #e5e7eb;color:#64748b">Signed by</td><td style="padding:10px;border-top:1px solid #e5e7eb">${signerName}</td></tr>
              <tr><td style="padding:10px;border-top:1px solid #e5e7eb;color:#64748b">Email</td><td style="padding:10px;border-top:1px solid #e5e7eb">${user?.email || 'Not available'}</td></tr>
              <tr><td style="padding:10px;border-top:1px solid #e5e7eb;color:#64748b">Signed at</td><td style="padding:10px;border-top:1px solid #e5e7eb">${signedAt}</td></tr>
            </table>
            ${signatureMarkup}
            <p style="color:#475569">This sign-off is now available in the ADMS administration acknowledgement report.</p>`),
        });
      }
    }
    res.json({ ...acknowledgement, status: 'Signed' });
  } catch (error) { next(error); }
};

const getDocumentAcknowledgements = async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    res.json(await findDocumentAcknowledgements(req.params.id));
  } catch (error) { next(error); }
};

const getDocumentPermissions = async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    res.json(await findDocumentPermissions(req.params.id));
  } catch (error) { next(error); }
};

const updateDocumentPermission = async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const values = req.body || {};
    res.json(await upsertDocumentPermission(req.params.id, {
      user_id: req.params.userId,
      view: values.view !== false,
      download: values.download === true,
      upload: values.upload === true,
      edit: values.edit === true,
      delete_permission: values.delete_permission === true,
      share: values.share === true,
      copy: values.copy === true,
    }));
  } catch (error) { next(error); }
};

module.exports = {
  uploadDocument,
  getAllDocuments,
  getDocumentFolders,
  createDocumentFolder,
  renameDocumentFolder,
  deleteDocumentFolder,
  uploadMultipleDocuments,
  getDocumentById,
  updateDocumentDetails,
  updateDocumentsDetails,
  getDocumentThumbnail,
  downloadDocument,
  deleteDocument,
  deleteDocuments,
  acknowledgeDocument,
  getDocumentAcknowledgements,
  getDocumentPermissions,
  updateDocumentPermission,
};
