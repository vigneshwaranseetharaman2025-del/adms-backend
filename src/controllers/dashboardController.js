const dashboardModel = require('../models/dashboardModel');
const { can } = require('../config/accessPolicy');

const validType = (value) => ['document', 'gallery'].includes(value);
const parseItem = (req, res) => {
  const itemType = String(req.body?.itemType || req.params.itemType || '');
  const itemId = parseInt(req.body?.itemId || req.params.itemId, 10);
  if (!validType(itemType) || !itemId) {
    res.status(400).json({ message: 'A valid itemType and itemId are required.' });
    return null;
  }
  return { itemType, itemId };
};

const getQuickActions = async (req, res, next) => {
  try {
    const [favorites, downloads, shared] = await Promise.all([
      dashboardModel.getFavorites(req.user.id),
      dashboardModel.getDownloads(req.user.id),
      dashboardModel.getShared(req.user.id),
    ]);
    res.json({ favorites, downloads, shared });
  } catch (error) { next(error); }
};

const getDashboardSummary = async (req, res, next) => {
  try {
    // Regular users only see templates and policies they are allowed to open.
    const accessUserId = can(req.user.access_level, 'documents.manage') ? null : req.user.id;
    res.json(await dashboardModel.getDashboardSummary(req.user.id, accessUserId));
  } catch (error) { next(error); }
};

const getRecentActivity = async (req, res, next) => {
  try {
    res.json(await dashboardModel.getRecentActivity());
  } catch (error) { next(error); }
};

const validateEvent = (body) => {
  const { title, date, startTime, endTime } = body || {};
  if (!title?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || endTime <= startTime) {
    return 'Title, date, and valid start/end times are required.';
  }
  return null;
};

const getEvents = async (req, res, next) => {
  try { res.json(await dashboardModel.getEvents()); } catch (error) { next(error); }
};

const createEvent = async (req, res, next) => {
  try {
    const message = validateEvent(req.body);
    if (message) return res.status(400).json({ message });
    res.status(201).json(await dashboardModel.createEvent(req.body, req.user.id));
  } catch (error) { next(error); }
};

const updateEvent = async (req, res, next) => {
  try {
    const message = validateEvent(req.body);
    if (message) return res.status(400).json({ message });
    const event = await dashboardModel.updateEvent(parseInt(req.params.id, 10), req.body);
    if (!event) return res.status(404).json({ message: 'Event not found.' });
    res.json(event);
  } catch (error) { next(error); }
};

const deleteEvent = async (req, res, next) => {
  try {
    const event = await dashboardModel.deleteEvent(parseInt(req.params.id, 10));
    if (!event) return res.status(404).json({ message: 'Event not found.' });
    res.status(204).send();
  } catch (error) { next(error); }
};

const addFavorite = async (req, res, next) => {
  try {
    const item = parseItem(req, res);
    if (!item) return;
    await dashboardModel.addFavorite(req.user.id, item.itemType, item.itemId);
    res.status(201).json({ ...item, favorite: true });
  } catch (error) { next(error); }
};

const removeFavorite = async (req, res, next) => {
  try {
    const item = parseItem(req, res);
    if (!item) return;
    await dashboardModel.removeFavorite(req.user.id, item.itemType, item.itemId);
    res.json({ ...item, favorite: false });
  } catch (error) { next(error); }
};

const clearAllFavorites = async (req, res, next) => {
  try {
    await dashboardModel.clearFavorites(req.user.id);
    res.status(204).send();
  } catch (error) { next(error); }
};

const clearDownload = async (req, res, next) => {
  try {
    const item = parseItem(req, res);
    if (!item) return;
    await dashboardModel.clearDownloads(req.user.id, item.itemType, item.itemId);
    res.status(204).send();
  } catch (error) { next(error); }
};

const clearAllDownloads = async (req, res, next) => {
  try {
    await dashboardModel.clearAllDownloads(req.user.id);
    res.status(204).send();
  } catch (error) { next(error); }
};

const clearShared = async (req, res, next) => {
  try {
    const messageId = parseInt(req.params.messageId, 10);
    if (!messageId) return res.status(400).json({ message: 'A valid messageId is required.' });
    await dashboardModel.hideShared(req.user.id, messageId);
    res.status(204).send();
  } catch (error) { next(error); }
};

const clearAllShared = async (req, res, next) => {
  try {
    await dashboardModel.hideAllShared(req.user.id);
    res.status(204).send();
  } catch (error) { next(error); }
};

module.exports = {
  getEvents, createEvent, updateEvent, deleteEvent, getQuickActions, getDashboardSummary, getRecentActivity, addFavorite, removeFavorite, clearAllFavorites,
  clearDownload, clearAllDownloads, clearShared, clearAllShared,
};