const sendModel = require('../models/campaignSendModel');
const { getSenderOptions, checkSenderEmail } = require('../services/senderIdentity');
const { loadCampaignAccess } = require('../middleware/campaignAccess');

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

/** What the signed-in user may do in Campaigns, so the screen can show or hide actions. */
const access = async (req, res, next) => {
  try { res.json(await loadCampaignAccess(req)); } catch (error) { next(error); }
};

const dashboard = async (req, res, next) => {
  try {
    const days = [7, 30, 90, 365].includes(toInt(req.query.days)) ? toInt(req.query.days) : 30;
    res.json(await sendModel.getDashboard({ days }));
  } catch (error) { next(error); }
};

/** Report rows: one per send operation (original sends and resends). */
const listSends = async (req, res, next) => {
  try {
    const page = Math.max(toInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(toInt(req.query.pageSize) || 10, 1), 100);
    const status = ['queued', 'sending', 'paused', 'cancelling', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(req.query.status) ? req.query.status : '';
    const kind = ['original', 'resend'].includes(req.query.kind) ? req.query.kind : '';
    res.json(await sendModel.listSends({
      page, pageSize, status, kind,
      search: String(req.query.search || '').trim().slice(0, 100),
      sort: String(req.query.sort || 'started_desc'),
      newsletterId: toInt(req.query.newsletterId)
    }));
  } catch (error) { next(error); }
};

const getSend = async (req, res, next) => {
  try {
    const send = await sendModel.getSend(toInt(req.params.sendId));
    if (!send) return res.status(404).json({ message: 'Send not found.' });
    res.json(send);
  } catch (error) { next(error); }
};

const senderOptions = async (req, res, next) => {
  try { res.json(await getSenderOptions()); } catch (error) { next(error); }
};

const senderCheck = async (req, res, next) => {
  try { res.json(await checkSenderEmail(req.query.email)); } catch (error) { next(error); }
};

module.exports = { access, dashboard, listSends, getSend, senderOptions, senderCheck };
