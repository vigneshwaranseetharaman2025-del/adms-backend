const crypto = require('crypto');
const path = require('path');
const storage = require('../storage');
const assetModel = require('../models/emailAssetModel');

// sharp is optional: without it uploads still work, only dimensions, optimisation and thumbnails are skipped.
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const MAX_EDGE = 2400; // larger pictures are scaled down: no mail app shows more, and they slow every inbox
const THUMB_EDGE = 480;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

const assetPath = (id) => `/api/email-assets/${id}/file`;
const withUrls = (asset) => asset && ({
  ...asset,
  url: assetPath(asset.id),
  thumbnailUrl: `${assetPath(asset.id)}?size=thumb&v=${new Date(asset.updatedAt || asset.createdAt || 0).getTime()}`
});

const cleanName = (value, fallback = 'Image') => {
  const name = String(value || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const label = (name || fallback).slice(0, 255);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Reads size, scales very large pictures down and builds a small preview for the library grid. */
const processImage = async (buffer, mimeType) => {
  if (!sharp || mimeType === 'image/gif') {
    let meta = {};
    if (sharp) { try { meta = await sharp(buffer, { animated: true }).metadata(); } catch { meta = {}; } }
    return { buffer, width: meta.width || null, height: meta.pageHeight || meta.height || null, thumb: null };
  }
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  let out = buffer;
  let { width, height } = meta;
  if ((width || 0) > MAX_EDGE || (height || 0) > MAX_EDGE || (meta.orientation || 1) > 1) {
    // .rotate() applies the camera orientation, so phone photos are stored upright.
    const pipeline = sharp(buffer, { failOn: 'none' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    if (mimeType === 'image/png') pipeline.png({ compressionLevel: 9 });
    else if (mimeType === 'image/webp') pipeline.webp({ quality: 86 });
    else pipeline.jpeg({ quality: 86, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    out = data;
    width = info.width;
    height = info.height;
  }
  const thumb = await sharp(out, { failOn: 'none' }).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return { buffer: out, width, height, thumb };
};

const thumbKeyFor = (storageKey) => `${storageKey}.thumb.webp`;

const storeFile = async (file) => {
  if (!ALLOWED.has(file.mimetype)) {
    const error = new Error(file.mimetype === 'image/svg+xml'
      ? 'SVG images are not supported: most mail apps do not show them. Use PNG or JPG instead.'
      : `"${file.originalname}" is not a supported image. Use JPG, PNG, GIF or WebP.`);
    error.status = 400;
    throw error;
  }
  const processed = await processImage(file.buffer, file.mimetype);
  const ext = EXT[file.mimetype] || path.extname(file.originalname || '') || '';
  const storageKey = `email-assets/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ext}`;
  await storage.upload(storageKey, processed.buffer, file.mimetype);
  if (processed.thumb) await storage.upload(thumbKeyFor(storageKey), processed.thumb, 'image/webp');
  return { storageKey, mimeType: file.mimetype, sizeBytes: processed.buffer.length, width: processed.width, height: processed.height, hasThumb: Boolean(processed.thumb) };
};

const removeFiles = async (storageKey) => {
  for (const key of [storageKey, thumbKeyFor(storageKey)]) {
    try { await storage.delete(key); } catch (error) { if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') console.warn('[email-assets] could not delete', key, error.message); }
  }
};

/* ------------------------------ where images are used ------------------------------ */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathOf = (url) => { try { return new URL(url, 'http://x').pathname; } catch { return url; } };

const matcherFor = (asset) => {
  const patterns = [`${escapeRegex(assetPath(asset.id))}(?![\\w-])`];
  if (asset.legacyUrl) patterns.push(`${escapeRegex(pathOf(asset.legacyUrl))}(?![\\w-])`);
  return new RegExp(patterns.join('|'));
};

const usageFor = (asset, containers) => {
  const re = matcherFor(asset);
  return containers.filter((item) => re.test(item.content)).map(({ type, id, name, status }) => ({ type, id, name, status }));
};

// Image URLs written in HTML (src="...") or in the builder's design JSON ("src":"...", "thumbnail":"...").
const IMAGE_REF = /(?:\bsrc\s*=\s*["']|"(?:src|thumbnail)"\s*:\s*")(https?:\/\/[^"'\s<>]+)/gi;

/** Images used in emails that are hosted elsewhere (not in the library), so they can be imported. */
const externalImages = (containers, assets) => {
  const known = assets.map(matcherFor);
  const byUrl = new Map();
  for (const item of containers) {
    for (const match of item.content.matchAll(IMAGE_REF)) {
      const url = match[1].replace(/&amp;/g, '&');
      if (/\/api\/newsletters\/track\//.test(url) || /\/api\/email-assets\/\d+\/file/.test(url)) continue;
      if (known.some((re) => re.test(url))) continue;
      const entry = byUrl.get(url) || { url, usedIn: [] };
      if (!entry.usedIn.some((u) => u.type === item.type && u.id === item.id)) entry.usedIn.push({ type: item.type, id: item.id, name: item.name, status: item.status });
      byUrl.set(url, entry);
    }
  }
  return [...byUrl.values()];
};

/* ---------------------------------- handlers ---------------------------------- */

const list = async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const sort = String(req.query.sort || 'newest');
    const [assets, containers] = await Promise.all([assetModel.listAssets({ search, sort }), assetModel.listImageContainers()]);
    const items = assets.map((asset) => ({ ...withUrls(asset), usedIn: usageFor(asset, containers) }));
    const response = { items };
    if (req.query.includeExternal === 'true') {
      const all = search ? await assetModel.listAssets({}) : assets;
      response.external = externalImages(containers, all);
    }
    res.json(response);
  } catch (error) { next(error); }
};

const getOne = async (req, res, next) => {
  try {
    const asset = await assetModel.findAsset(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).json({ message: 'Image not found.' });
    res.json({ ...withUrls(asset), usedIn: usageFor(asset, await assetModel.listImageContainers()) });
  } catch (error) { next(error); }
};

const upload = async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'Choose at least one image to upload.' });
    const parentId = req.body?.parentId ? parseInt(req.body.parentId, 10) || null : null;
    const created = [];
    const failed = [];
    for (const file of files) {
      try {
        const stored = await storeFile(file);
        created.push(withUrls(await assetModel.createAsset({
          ...stored,
          name: cleanName(req.body?.name || file.originalname),
          originalName: String(file.originalname || '').slice(0, 255),
          source: parentId ? 'edited' : 'upload',
          parentId,
          userId: req.user?.id
        })));
      } catch (error) {
        if (error.status === 400) failed.push({ name: file.originalname, message: error.message });
        else throw error;
      }
    }
    if (!created.length) return res.status(400).json({ message: failed[0]?.message || 'No image could be uploaded.', failed });
    res.status(201).json({ items: created.map((asset) => ({ ...asset, usedIn: [] })), failed });
  } catch (error) { next(error); }
};

/** Saves an edited picture over the original, so every email using it updates. */
const replace = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const asset = await assetModel.findAsset(id);
    if (!asset) return res.status(404).json({ message: 'Image not found.' });
    if (!req.file) return res.status(400).json({ message: 'Choose an image.' });
    const stored = await storeFile(req.file);
    const updated = await assetModel.replaceAssetFile(id, stored);
    if (asset.storageKey !== stored.storageKey) await removeFiles(asset.storageKey);
    res.json({ ...withUrls(updated), usedIn: usageFor(updated, await assetModel.listImageContainers()) });
  } catch (error) { next(error); }
};

const rename = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Enter a name for the image.' });
    const asset = await assetModel.renameAsset(parseInt(req.params.id, 10), name.slice(0, 255));
    if (!asset) return res.status(404).json({ message: 'Image not found.' });
    res.json(withUrls(asset));
  } catch (error) { next(error); }
};

const removeOne = async (id, force, containers) => {
  const asset = await assetModel.findAsset(id);
  if (!asset) return { id, status: 404 };
  const usedIn = usageFor(asset, containers);
  if (usedIn.length && !force) return { id, status: 409, usedIn };
  await assetModel.deleteAsset(id);
  await removeFiles(asset.storageKey);
  return { id, status: 204 };
};

const remove = async (req, res, next) => {
  try {
    const result = await removeOne(parseInt(req.params.id, 10), req.query.force === 'true', await assetModel.listImageContainers());
    if (result.status === 404) return res.status(404).json({ message: 'Image not found.' });
    if (result.status === 409) return res.status(409).json({ message: 'This image is used in emails. Confirm to delete it anyway.', usedIn: result.usedIn });
    res.status(204).end();
  } catch (error) { next(error); }
};

const bulkRemove = async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((v) => parseInt(v, 10)).filter(Boolean))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ message: 'Select at least one image.' });
    const containers = await assetModel.listImageContainers();
    const results = [];
    for (const id of ids) results.push(await removeOne(id, req.body?.force === true, containers));
    res.json({
      deleted: results.filter((r) => r.status === 204).map((r) => r.id),
      blocked: results.filter((r) => r.status === 409).map((r) => ({ id: r.id, usedIn: r.usedIn }))
    });
  } catch (error) { next(error); }
};

/** Copies a picture that an email loads from another website into the library. */
const importUrl = async (req, res, next) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ message: 'Enter a web address starting with http:// or https://.' });
    let response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch {
      return res.status(502).json({ message: 'That image could not be downloaded. Check the address, or download it and upload it instead.' });
    }
    if (!response.ok) return res.status(502).json({ message: `The website returned an error (${response.status}).` });
    const mimetype = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ message: 'That image is larger than 10 MB.' });
    const originalname = decodeURIComponent(pathOf(url).split('/').pop() || 'image');
    const stored = await storeFile({ buffer, mimetype, originalname });
    const asset = await assetModel.createAsset({
      ...stored, name: cleanName(req.body?.name || originalname), originalName: originalname.slice(0, 255), source: 'import', userId: req.user?.id
    });
    res.status(201).json({ ...withUrls(asset), usedIn: [] });
  } catch (error) { next(error); }
};

/** Public: email images must load in every recipient's mail app without signing in. */
const file = async (req, res, next) => {
  try {
    const asset = await assetModel.findAsset(parseInt(req.params.id, 10));
    if (!asset) return res.status(404).end();
    // Short cache + Last-Modified: after "Replace original" every email shows the new picture within a minute.
    const modified = new Date(asset.updatedAt || asset.createdAt || Date.now());
    modified.setMilliseconds(0);
    const since = req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']) : null;
    if (since && !Number.isNaN(since.getTime()) && modified <= since) return res.status(304).end();
    res.set('Last-Modified', modified.toUTCString());
    let wantsThumb = req.query.size === 'thumb' && sharp && asset.mimeType !== 'image/gif' && !asset.legacyUrl;
    const key = wantsThumb ? thumbKeyFor(asset.storageKey) : asset.storageKey;
    const open = async (k) => storage.getStream(k);
    let stream;
    try { stream = await open(key); } catch (error) { if (!wantsThumb) throw error; wantsThumb = false; stream = await open(asset.storageKey); }
    res.set({
      'Content-Type': wantsThumb ? 'image/webp' : asset.mimeType,
      'Content-Disposition': 'inline',
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    stream.on('error', async (error) => {
      // An older upload without a preview falls back to the full picture.
      if (wantsThumb && !res.headersSent && (error.code === 'ENOENT' || error.name === 'NoSuchKey')) {
        try {
          res.set('Content-Type', asset.mimeType);
          stream = await open(asset.storageKey);
          stream.on('error', () => (res.headersSent ? res.destroy() : res.status(404).end()));
          stream.pipe(res);
        } catch { res.status(404).end(); }
        return;
      }
      if (res.headersSent) return res.destroy();
      if (error.code === 'ENOENT') return res.status(404).end();
      next(error);
    });
    stream.pipe(res);
  } catch (error) {
    if (error.name === 'NoSuchKey') return res.status(404).end();
    next(error);
  }
};

module.exports = { list, getOne, upload, replace, rename, remove, bulkRemove, importUrl, file };
