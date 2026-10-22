const crypto = require('crypto');
const queue = require('../models/sendQueueModel');
const control = require('../services/campaign/sendControl');

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

const reply = (res, result) => {
  if (!result) return res.status(404).json({ message: 'Send not found.' });
  if (result.error) return res.status(409).json({ message: result.error, code: result.code });
  return res.json(result);
};

const progress = async (req, res, next) => {
  try {
    const p = await control.buildProgress(toInt(req.params.sendId));
    if (!p) return res.status(404).json({ message: 'Send not found.' });
    res.json(p);
  } catch (error) { next(error); }
};

/** Sends that are running, paused or finished in the last 15 minutes: lets the live panel pick up after a refresh. */
const active = async (req, res, next) => {
  try {
    const ids = await queue.activeSends();
    res.json({ items: (await Promise.all(ids.map((id) => control.buildProgress(id)))).filter(Boolean) });
  } catch (error) { next(error); }
};

const recipients = async (req, res, next) => {
  try {
    const sendId = toInt(req.params.sendId);
    const filter = Object.keys(queue.RECIPIENT_FILTERS).includes(req.query.filter) ? req.query.filter : 'all';
    const sort = ['recent', 'status', 'attempts', 'email'].includes(req.query.sort) ? req.query.sort : 'recent';
    res.json(await queue.listRecipients(sendId, {
      page: Math.max(toInt(req.query.page) || 1, 1),
      pageSize: Math.min(Math.max(toInt(req.query.pageSize) || 25, 1), 200),
      filter,
      sort,
      search: String(req.query.search || '').trim().slice(0, 100)
    }));
  } catch (error) { next(error); }
};

const pause = async (req, res, next) => { try { reply(res, await control.pause(toInt(req.params.sendId), req.user.id)); } catch (error) { next(error); } };
const resume = async (req, res, next) => { try { reply(res, await control.resume(toInt(req.params.sendId))); } catch (error) { next(error); } };
const cancel = async (req, res, next) => { try { reply(res, await control.requestCancel(toInt(req.params.sendId), req.user.id)); } catch (error) { next(error); } };
const retryFailed = async (req, res, next) => { try { reply(res, await control.retryFailed(toInt(req.params.sendId))); } catch (error) { next(error); } };
const retryRecipient = async (req, res, next) => {
  try {
    reply(res, await control.retryRecipient(toInt(req.params.sendId), toInt(req.params.recipientId), { force: req.body?.force === true }));
  } catch (error) { next(error); }
};

/**
 * Delivery events from the mail provider (delivered / bounced). Disabled unless CAMPAIGN_WEBHOOK_SECRET
 * is set; the provider (or a small relay) must send it in the X-ADMS-Webhook-Secret header.
 * Body: { events: [{ id, type: 'delivered' | 'bounced', messageId?, email?, sendId?, timestamp?, reason? }] }
 * Each provider event id is stored once, so webhook retries never inflate the counts.
 */
const providerEvents = async (req, res, next) => {
  try {
    const secret = String(process.env.CAMPAIGN_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(404).json({ message: 'Delivery webhooks are not enabled.' });
    const given = String(req.get('x-adms-webhook-secret') || '');
    const a = Buffer.from(given); const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ message: 'Invalid webhook secret.' });
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 1000) : [];
    const results = { applied: 0, duplicate: 0, unknown: 0, invalid: 0 };
    for (const e of events) {
      const type = ['delivered', 'bounced'].includes(e?.type) ? e.type : null;
      const eventId = String(e?.id || '').slice(0, 200);
      if (!type || !eventId) { results.invalid += 1; continue; }
      const r = await queue.applyProviderEvent({ eventId, type, messageId: e.messageId, email: e.email, sendId: toInt(e.sendId), occurredAt: e.timestamp, detail: e.reason });
      if (r.applied) results.applied += 1; else if (r.reason === 'duplicate') results.duplicate += 1; else results.unknown += 1;
    }
    res.json(results);
  } catch (error) { next(error); }
};

module.exports = { progress, active, recipients, pause, resume, cancel, retryFailed, retryRecipient, providerEvents };
