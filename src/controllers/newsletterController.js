const crypto = require('crypto');
const storage = require('../storage');
const newsletterModel = require('../models/newsletterModel');
const emailAssetModel = require('../models/emailAssetModel');
const sendModel = require('../models/campaignSendModel');
const { resolveSender, SenderError, bareAddress, cleanName } = require('../services/senderIdentity');
const { mailer, describeMailError } = require('../config/mailer');
const { emitAutomationEvent } = require('../services/automation/triggers');
const { renderTemplate, getRecipientProfile } = require('../services/automation/personalization');
const queue = require('../models/sendQueueModel');
const { campaignWorker } = require('../services/campaign/worker');
const { trackingOriginFor } = require('../services/campaign/trackingOrigin');
const { buildProgress, requestCancel } = require('../services/campaign/sendControl');

const pipeImageStream = (imageStream, res, next) => {
  imageStream.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    if (error.code === 'ENOENT') return res.status(404).end();
    next(error);
  });
  imageStream.pipe(res);
};

// Block design from the email builder: an object with rows, at most 1 MB. null = HTML-only campaign.
const parseDesign = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || !Array.isArray(value.rows)) return false;
  return JSON.stringify(value).length <= 1024 * 1024 ? value : false;
};

const validateNewsletter = (body) => {
  const title = String(body?.title || '').trim();
  const subject = String(body?.subject || '').trim();
  const description = String(body?.description || '').trim();
  const category = String(body?.category || 'Knowledge').trim();
  const imageUrl = String(body?.imageUrl || body?.image_url || '').trim();
  const htmlContent = String(body?.htmlContent || '').trim();
  const isBlog = body?.isBlog === true || body?.is_blog === true;
  if (!title || !subject || !htmlContent) return 'Title, subject, and HTML content are required.';
  if (title.length > 255 || subject.length > 255) return 'Title and subject must be 255 characters or fewer.';
  const designJson = parseDesign(body?.designJson);
  if (designJson === false) return 'The email design is invalid or too large.';
  // Sender details are saved with the draft; whether the address is authorised is checked when sending.
  const fromName = cleanName(body?.fromName) || null;
  const fromEmail = bareAddress(body?.fromEmail) || null;
  const replyTo = bareAddress(body?.replyTo) || null;
  if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) return 'The sender email address is not valid.';
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return 'The reply-to address is not valid.';
  const baseUpdatedAt = body?.baseUpdatedAt && !Number.isNaN(new Date(body.baseUpdatedAt).getTime()) ? body.baseUpdatedAt : null;
  return { title, subject, description, category, imageUrl, htmlContent, isBlog, designJson, fromName, fromEmail, replyTo, baseUpdatedAt, force: body?.force === true };
};

const list = async (req, res, next) => {
  try { res.json(await newsletterModel.listNewsletters()); } catch (error) { next(error); }
};

const sent = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '10', 10), 1), 50);
    res.json(await newsletterModel.listSentNewsletters(page, pageSize));
  } catch (error) { next(error); }
};

const getOne = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findNewsletterById(parseInt(req.params.id, 10));
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    res.json({ ...newsletter, images: await newsletterModel.listNewsletterImages(newsletter.id) });
  } catch (error) { next(error); }
};

const published = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '6', 10), 1), 24);
    res.json(await newsletterModel.listPublishedNewsletters(page, pageSize));
  } catch (error) { next(error); }
};

const publishedOne = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findPublishedNewsletterById(parseInt(req.params.id, 10));
    if (!newsletter) return res.status(404).json({ message: 'Published newsletter not found.' });
    res.json(newsletter);
  } catch (error) { next(error); }
};

const isValidToken = (token) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(token || ''));

const trackingPixel = async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (isValidToken(token)) {
      const opened = await newsletterModel.markNewsletterOpened(token);
      if (opened) void emitAutomationEvent('email_opened', { email: opened.email, newsletterId: opened.newsletter_id, eventKey: `${opened.newsletter_id}:${opened.email}` });
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
  } catch (error) { next(error); }
};

const trackClick = async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const target = String(req.query.u || '');
    let safeTarget = '/';
    if (/^https?:\/\//i.test(target)) safeTarget = target;
    if (isValidToken(token)) {
      const clicked = await newsletterModel.markNewsletterClicked(token);
      if (clicked) void emitAutomationEvent('email_clicked', { email: clicked.email, newsletterId: clicked.newsletter_id, eventKey: `${clicked.newsletter_id}:${clicked.email}` });
    }
    res.redirect(302, safeTarget);
  } catch (error) { next(error); }
};

const stats = async (req, res, next) => {
  try { res.json(await newsletterModel.getNewsletterStats()); } catch (error) { next(error); }
};

const listTemplates = async (req, res, next) => {
  try { res.json(await newsletterModel.listNewsletterTemplates()); } catch (error) { next(error); }
};

const saveTemplate = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    const category = String(req.body?.category || 'Custom').trim();
    const htmlContent = String(req.body?.htmlContent || '').trim();
    if (!name || !htmlContent) return res.status(400).json({ message: 'Template name and content are required.' });
    if (name.length > 150) return res.status(400).json({ message: 'Template name must be 150 characters or fewer.' });
    const designJson = parseDesign(req.body?.designJson);
    if (designJson === false) return res.status(400).json({ message: 'The template design is invalid or too large.' });
    res.status(201).json(await newsletterModel.createNewsletterTemplate({ name, description, category, htmlContent, designJson, userId: req.user.id }));
  } catch (error) { next(error); }
};

const removeTemplate = async (req, res, next) => {
  try {
    const deleted = await newsletterModel.deleteNewsletterTemplate(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ message: 'Template not found or cannot be deleted.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

const recipients = async (req, res, next) => {
  try { res.json(await newsletterModel.listOrganisationRecipients()); } catch (error) { next(error); }
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const createContact = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!name || name.length > 150) return res.status(400).json({ message: 'Contact name is required and must be 150 characters or fewer.' });
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    res.status(201).json(await newsletterModel.createNewsletterContact({ name, email, userId: req.user.id }));
  } catch (error) { next(error); }
};

const importContacts = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const contacts = rows
      .map((row) => ({ name: String(row?.name || '').trim().slice(0, 150) || String(row?.email || '').trim(), email: String(row?.email || '').trim().toLowerCase() }))
      .filter((row) => isValidEmail(row.email));
    if (!contacts.length) return res.status(400).json({ message: 'No valid contacts found to import. Each row needs at least a valid email address.' });
    const result = await newsletterModel.bulkImportNewsletterContacts(contacts, req.user.id);
    res.status(201).json(result);
  } catch (error) { next(error); }
};

const removeContact = async (req, res, next) => {
  try {
    const deleted = await newsletterModel.deleteNewsletterContact(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ message: 'Contact not found.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

const tracking = async (req, res, next) => {
  try { res.json(await newsletterModel.listNewsletterTracking(parseInt(req.params.id, 10))); } catch (error) { next(error); }
};

const groups = async (req, res, next) => {
  try { res.json(await newsletterModel.listNewsletterGroups()); } catch (error) { next(error); }
};

const createGroup = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#1976d2').trim();
    const memberEmails = Array.isArray(req.body?.memberEmails)
      ? [...new Set(req.body.memberEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!name || name.length > 100) return res.status(400).json({ message: 'Group name is required and must be 100 characters or fewer.' });
    if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ message: 'Choose a valid group color.' });
    const validEmails = new Set(await newsletterModel.findOrganisationEmails());
    if (!memberEmails.length || memberEmails.some((email) => !validEmails.has(email))) return res.status(400).json({ message: 'Select at least one valid organisation member.' });
    res.status(201).json(await newsletterModel.createNewsletterGroup({ name, color, memberEmails, userId: req.user.id }));
  } catch (error) { next(error); }
};

const updateGroup = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#1976d2').trim();
    const memberEmails = Array.isArray(req.body?.memberEmails)
      ? [...new Set(req.body.memberEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!name || name.length > 100) return res.status(400).json({ message: 'Group name is required and must be 100 characters or fewer.' });
    if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ message: 'Choose a valid group color.' });
    const validEmails = new Set(await newsletterModel.findOrganisationEmails());
    if (!memberEmails.length || memberEmails.some((email) => !validEmails.has(email))) return res.status(400).json({ message: 'Select at least one valid organisation member.' });
    const group = await newsletterModel.updateNewsletterGroup({ id: parseInt(req.params.id, 10), name, color, memberEmails });
    if (!group) return res.status(404).json({ message: 'Newsletter group not found.' });
    res.json(group);
  } catch (error) { next(error); }
};

const deleteGroup = async (req, res, next) => {
  try {
    const deleted = await newsletterModel.deleteNewsletterGroup(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ message: 'Newsletter group not found.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

const uploadImage = async (req, res, next) => {
  try {
    if (!req.file?.mimetype?.startsWith('image/')) return res.status(400).json({ message: 'Please upload an image file.' });
    const id = parseInt(req.params.id, 10);
    const newsletter = await newsletterModel.findNewsletterById(id);
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    const extension = req.file.originalname.includes('.') ? req.file.originalname.slice(req.file.originalname.lastIndexOf('.')) : '';
    const imageKey = `newsletters/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;
    await storage.upload(imageKey, req.file.buffer, req.file.mimetype);
    res.json(await newsletterModel.updateNewsletterImage(id, imageKey, `/api/newsletters/${id}/image`, req.file.mimetype));
  } catch (error) { next(error); }
};

const uploadImages = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const newsletter = await newsletterModel.findNewsletterById(id);
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    const files = (req.files || []).filter((file) => file.mimetype?.startsWith('image/'));
    if (!files.length) return res.status(400).json({ message: 'Please upload at least one image file.' });
    const images = [];
    for (const file of files) {
      const extension = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '';
      const imageKey = `newsletters/${id}/${crypto.randomUUID()}${extension}`;
      await storage.upload(imageKey, file.buffer, file.mimetype);
      images.push(await newsletterModel.createNewsletterImage({
        newsletterId: id,
        storageKey: imageKey,
        imageUrl: `/api/newsletters/${id}/images/pending`,
        mimeType: file.mimetype,
        originalName: file.originalname,
      }));
    }
    for (const image of images) {
      const updated = await newsletterModel.updateNewsletterImageUrl(image.id, `/api/newsletters/${id}/images/${image.id}`);
      Object.assign(image, updated);
    }
    res.status(201).json(images);
  } catch (error) { next(error); }
};

const getImageAsset = async (req, res, next) => {
  try {
    const image = await newsletterModel.findNewsletterImage(parseInt(req.params.id, 10), parseInt(req.params.imageId, 10));
    if (!image) return res.status(404).end();
    const imageStream = await storage.getStream(image.storageKey);
    res.set({
      'Content-Type': image.mimeType || 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=86400',
    });
    pipeImageStream(imageStream, res, next);
  } catch (error) { next(error); }
};

const deleteImage = async (req, res, next) => {
  try {
    const image = await newsletterModel.deleteNewsletterImage(parseInt(req.params.id, 10), parseInt(req.params.imageId, 10));
    if (!image) return res.status(404).json({ message: 'Newsletter image not found.' });
    const shared = await emailAssetModel.storageKeysInLibrary([image.storageKey]);
    if (!shared.has(image.storageKey)) await storage.delete(image.storageKey);
    res.status(204).end();
  } catch (error) { next(error); }
};

const removeDraft = async (req, res, next) => {
  try {
    const deleted = await newsletterModel.deleteNewsletterDraft(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ message: 'Draft not found or cannot be deleted.' });
    // Images that are in the shared library may be used by templates or other campaigns: keep their files.
    const shared = await emailAssetModel.storageKeysInLibrary(deleted.storageKeys);
    await Promise.all(deleted.storageKeys.filter((storageKey) => !shared.has(storageKey)).map((storageKey) => storage.delete(storageKey).catch(() => {})));
    res.status(204).end();
  } catch (error) { next(error); }
};

const getImage = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findNewsletterById(parseInt(req.params.id, 10));
    if (!newsletter?.image_key) return res.status(404).end();
    const imageStream = await storage.getStream(newsletter.image_key);
    res.setHeader('Content-Type', newsletter.image_mime_type || 'application/octet-stream');
    pipeImageStream(imageStream, res, next);
  } catch (error) { next(error); }
};

const save = async (req, res, next) => {
  try {
    const values = validateNewsletter(req.body);
    if (typeof values === 'string') return res.status(400).json({ message: values });
    const id = req.params.id ? parseInt(req.params.id, 10) : null;
    let newsletter;
    try {
      newsletter = await newsletterModel.saveNewsletter({ ...values, id, userId: req.user.id });
    } catch (error) {
      if (error instanceof newsletterModel.SaveConflictError) {
        const c = error.current;
        return res.status(409).json({
          code: 'DRAFT_CHANGED',
          message: `${c.updated_by_name || 'Someone'} saved changes to this campaign at ${new Date(c.updated_at).toLocaleString()} after you opened it.`,
          updatedAt: c.updated_at, updatedByName: c.updated_by_name
        });
      }
      throw error;
    }
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    res.status(id ? 200 : 201).json(newsletter);
  } catch (error) { next(error); }
};

/* ------------------------------------ sending ------------------------------------ */

const isKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(v);
const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * Splits a requested audience into people who will be emailed and people who will not (and why).
 * Eligible: organisation contacts with a valid address that never hard-bounced or came back "unknown user".
 * Format checks only catch typos; they do not prove a mailbox exists, which is why SMTP rejections are
 * recorded per recipient and remembered for later sends.
 */
const splitRecipients = async (emails) => {
  const directory = new Map((await newsletterModel.listOrganisationRecipients()).map((r) => [r.email, r.name]));
  const blocked = new Set([...(await sendModel.findBouncedEmails()), ...(await queue.findUnknownMailboxes())]);
  const eligible = [];
  const suppressed = [];
  let bouncedCount = 0;
  for (const email of [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]) {
    if (!EMAIL_RE.test(email)) suppressed.push({ email, reason: 'Invalid email address' });
    else if (!directory.has(email)) suppressed.push({ email, reason: 'Not an organisation contact' });
    else if (blocked.has(email)) { bouncedCount += 1; suppressed.push({ email, name: directory.get(email), reason: 'Bounced or reported as an unknown mailbox before' }); }
    else eligible.push({ email, name: directory.get(email) || null });
  }
  return { eligible, suppressed, bouncedCount };
};

/** Kept for the audience preview: counts only. */
const eligibleRecipients = async (emails) => {
  const { eligible, suppressed, bouncedCount } = await splitRecipients(emails);
  return { eligible: eligible.map((r) => r.email), excluded: suppressed.length, bouncedCount };
};

const senderFrom = (body, newsletter) => ({
  fromName: body?.fromName ?? newsletter.fromName,
  fromEmail: body?.fromEmail ?? newsletter.fromEmail,
  replyTo: body?.replyTo ?? newsletter.replyTo
});

const respondSenderError = (res, error) => res.status(400).json({ message: error.message, code: error.code });

/**
 * What this send will contain. The confirmation dialog sends either:
 *  - content: { subject, htmlContent }  the editor's current version, chosen explicitly by the user, or
 *  - savedVersion: <updated_at>         "send the saved campaign", which must still be the version they saw.
 * Either way the result becomes the send's snapshot: later edits never change a running send.
 */
const contentFor = (body, newsletter) => {
  const override = body?.content;
  if (override && typeof override === 'object') {
    const subject = String(override.subject || '').trim();
    const html = String(override.htmlContent || '').trim();
    if (!subject || !html) return { error: 'The email needs a subject and content before it can be sent.' };
    if (subject.length > 255) return { error: 'The subject must be 255 characters or fewer.' };
    if (html.length > 5 * 1024 * 1024) return { error: 'The email content is too large (over 5 MB).' };
    return { subject, html, source: 'editor' };
  }
  if (body?.savedVersion && newsletter.updated_at && Math.abs(new Date(body.savedVersion).getTime() - new Date(newsletter.updated_at).getTime()) > 1) {
    return { conflict: true };
  }
  if (!String(newsletter.html_content || '').trim()) return { error: 'This campaign has no saved content to send.' };
  return { subject: newsletter.subject, html: newsletter.html_content, source: 'saved' };
};

/** Validates, snapshots and queues one send. The campaign worker does the actual sending. */
const queueSend = async ({ req, res, newsletter, kind, audienceType, audienceLabel, groupIds = [], emails, key }) => {
  if (await queue.findActiveForNewsletter(newsletter.id)) {
    return res.status(409).json({ code: 'SEND_IN_PROGRESS', message: 'This campaign is already being sent (or is paused). Finish, resume or cancel that send first.' });
  }
  const content = contentFor(req.body, newsletter);
  if (content.error) return res.status(400).json({ code: 'CONTENT_INVALID', message: content.error });
  if (content.conflict) {
    return res.status(409).json({ code: 'CONTENT_CHANGED', message: 'The saved campaign changed after you opened the confirmation. Review it again before sending.' });
  }
  let sender;
  try { sender = await resolveSender(senderFrom(req.body, newsletter)); } catch (error) { if (error instanceof SenderError) return respondSenderError(res, error); throw error; }

  const { eligible, suppressed, bouncedCount } = await splitRecipients(emails);
  if (!eligible.length) {
    return res.status(400).json({ code: 'NO_ELIGIBLE_RECIPIENTS', message: bouncedCount ? 'Every chosen address bounced or was reported unknown before, so nothing was sent.' : 'None of the chosen people are organisation contacts with a valid email address.' });
  }
  const sendId = await queue.createQueuedSend({
    newsletterId: newsletter.id, kind, audienceType, audienceLabel, groupIds,
    subject: content.subject, html: content.html, contentSource: content.source,
    fromName: sender.name, fromEmail: sender.email, replyTo: sender.replyTo,
    recipients: eligible, suppressed, idempotencyKey: key, userId: req.user.id, trackingOrigin: trackingOriginFor(req)
  });
  if (!sendId) return res.status(409).json({ code: 'DUPLICATE_SEND', message: 'This send was already started. It was not sent twice.', send: await sendModel.findSendByKey(key) });
  campaignWorker.kick(sendId);
  return res.status(202).json({ sendId, jobId: String(sendId), total: eligible.length, excluded: suppressed.length, sent: 0, status: 'queued', contentSource: content.source });
};

/**
 * Body: { idempotencyKey, recipientEmails?, audienceType?, audienceLabel?, fromName?, fromEmail?, replyTo?, content? | savedVersion? }
 * Answers 202 as soon as the send is queued; progress comes from /sends/:id/progress.
 */
const send = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findNewsletterById(parseInt(req.params.id, 10));
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    const key = isKey(req.body?.idempotencyKey) ? req.body.idempotencyKey : null;
    if (!key) return res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'Missing idempotency key. Reload the page and try again.' });
    const existing = await sendModel.findSendByKey(key);
    if (existing) return res.status(409).json({ code: 'DUPLICATE_SEND', message: 'This send was already started. It was not sent twice.', send: existing });

    const requestedEmails = Array.isArray(req.body?.recipientEmails) ? req.body.recipientEmails : null;
    const emails = requestedEmails || await newsletterModel.findOrganisationEmails();
    const audienceType = requestedEmails ? (req.body?.audienceType === 'group' ? 'group' : requestedEmails.length === 1 ? 'individual' : 'contacts') : 'organisation';
    const audienceLabel = req.body?.audienceLabel || (requestedEmails ? `${requestedEmails.length} selected recipient${requestedEmails.length === 1 ? '' : 's'}` : 'Entire organisation');
    return await queueSend({ req, res, newsletter, kind: 'original', audienceType, audienceLabel, emails, key });
  } catch (error) { next(error); }
};

/**
 * Sends an already-sent campaign again to a new audience. It gets its own send record and recipient rows,
 * so the original send's report stays exactly as it was.
 * Body: { audience: { type: 'organisation' | 'group' | 'contacts' | 'individual', groupIds, emails }, fromName, fromEmail, replyTo, idempotencyKey }
 */
const resend = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findNewsletterById(parseInt(req.params.id, 10));
    if (!newsletter) return res.status(404).json({ message: 'Campaign not found.' });
    if (newsletter.status !== 'sent') return res.status(400).json({ message: 'Only a campaign that has been sent can be resent. Send it from Compose first.' });
    const key = isKey(req.body?.idempotencyKey) ? req.body.idempotencyKey : null;
    if (!key) return res.status(400).json({ message: 'Missing idempotency key.' });
    const existing = await sendModel.findSendByKey(key);
    if (existing) return res.status(409).json({ code: 'DUPLICATE_SEND', message: 'This resend was already started. It was not sent twice.', send: existing });

    const audience = req.body?.audience || {};
    const type = ['organisation', 'group', 'contacts', 'individual'].includes(audience.type) ? audience.type : null;
    if (!type) return res.status(400).json({ message: 'Choose who should receive the resend.' });
    let emails = [];
    let label = '';
    let groupIds = [];
    if (type === 'organisation') {
      emails = await newsletterModel.findOrganisationEmails();
      label = 'Entire organisation';
    } else if (type === 'group') {
      groupIds = [...new Set((Array.isArray(audience.groupIds) ? audience.groupIds : []).map((v) => parseInt(v, 10)).filter(Boolean))];
      const groups = (await newsletterModel.listNewsletterGroups()).filter((g) => groupIds.includes(g.id));
      if (!groups.length) return res.status(400).json({ message: 'Choose at least one contact list.' });
      emails = groups.flatMap((g) => g.memberEmails || []);
      label = groups.map((g) => g.name).join(', ');
    } else {
      emails = Array.isArray(audience.emails) ? audience.emails : [];
      if (type === 'individual' && emails.length !== 1) return res.status(400).json({ message: 'Choose one contact.' });
      if (!emails.length) return res.status(400).json({ message: 'Choose at least one contact.' });
      label = type === 'individual' ? String(emails[0]).toLowerCase() : `${new Set(emails).size} selected contacts`;
    }
    // A resend always uses the campaign's saved content (the content shown in its review step).
    req.body = { ...req.body, content: undefined };
    return await queueSend({ req, res, newsletter, kind: 'resend', audienceType: type, audienceLabel: label, groupIds, emails, key });
  } catch (error) { next(error); }
};

/** Counts who a resend or send would reach, without sending: for the confirmation step. */
const previewAudience = async (req, res, next) => {
  try {
    const audience = req.body?.audience || {};
    let emails = [];
    if (audience.type === 'organisation') emails = await newsletterModel.findOrganisationEmails();
    else if (audience.type === 'group') {
      const ids = (audience.groupIds || []).map((v) => parseInt(v, 10));
      emails = (await newsletterModel.listNewsletterGroups()).filter((g) => ids.includes(g.id)).flatMap((g) => g.memberEmails || []);
    } else emails = Array.isArray(audience.emails) ? audience.emails : [];
    const { eligible, suppressed, bouncedCount } = await splitRecipients(emails);
    const reasons = suppressed.reduce((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] || 0) + 1 }), {});
    res.json({ count: eligible.length, excluded: suppressed.length, bounced: bouncedCount, reasons, excludedSample: suppressed.slice(0, 20) });
  } catch (error) { next(error); }
};

/** Old progress endpoint (job id = send id). Same shape as before: { sent, total, status, error }. */
const sendProgress = async (req, res, next) => {
  try {
    const id = parseInt(req.params.jobId, 10);
    const progress = Number.isFinite(id) ? await buildProgress(id) : null;
    if (!progress) return res.status(404).json({ message: 'Send job not found.' });
    const legacy = ['queued', 'sending', 'paused', 'cancelling'].includes(progress.status) ? 'sending' : progress.status === 'completed_with_errors' ? 'completed' : progress.status;
    res.json({ jobId: String(id), sendId: id, sent: progress.counts.accepted, total: progress.counts.total, status: legacy, error: progress.lastError, progress });
  } catch (error) { next(error); }
};

const cancelSend = async (req, res, next) => {
  try {
    const id = parseInt(req.params.jobId, 10);
    const result = Number.isFinite(id) ? await requestCancel(id, req.user.id) : null;
    if (!result) return res.status(404).json({ message: 'Send job not found.' });
    if (result.error) return res.status(409).json({ message: result.error });
    res.json({ ...result.progress, status: 'cancelled' });
  } catch (error) { next(error); }
};

const testSend = async (req, res, next) => {
  try {
    const newsletter = await newsletterModel.findNewsletterById(parseInt(req.params.id, 10));
    const emails = Array.isArray(req.body?.emails) ? [...new Set(req.body.emails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))] : [];
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found.' });
    if (!emails.length) return res.status(400).json({ message: 'Choose at least one person to send the test to.' });
    if (emails.length > 5) return res.status(400).json({ message: 'A test can go to at most 5 people.' });
    if (!String(newsletter.html_content || '').trim()) return res.status(400).json({ message: 'This campaign has no content yet. Add content and save before sending a test.' });
    const validRecipients = await newsletterModel.findOrganisationEmails();
    const invalidEmail = emails.find((email) => !validRecipients.includes(email));
    if (invalidEmail) return res.status(400).json({ message: `${invalidEmail} is not an organisation member with an email address.` });

    let sender;
    try {
      // Tests go out with the sender details chosen for this campaign, so they look like the real send.
      sender = (await resolveSender(senderFrom(req.body, newsletter))).headers;
    } catch (error) {
      if (error instanceof SenderError) return respondSenderError(res, error);
      console.error('[test-send] sender identity failed', error);
      return res.status(503).json({ message: 'The default sender domain could not be loaded (DKIM key problem). Re-verify it under Domain authentication or remove it as default.', code: 'SENDER_IDENTITY' });
    }

    // A test can use the editor's unsaved version, so people can check edits before saving them.
    const content = req.body?.content ? contentFor({ content: req.body.content }, newsletter) : { subject: newsletter.subject, html: newsletter.html_content };
    if (content.error) return res.status(400).json({ message: content.error });

    // Each tester sees the email personalised for themselves.
    const delivered = [];
    for (const email of emails) {
      const profile = await getRecipientProfile(email);
      try {
        await mailer.sendMail({
          ...sender,
          to: email,
          subject: `[TEST] ${renderTemplate(content.subject, profile)}`,
          html: renderTemplate(content.html, profile, { html: true })
        });
        delivered.push(email);
      } catch (error) {
        const { status, message } = describeMailError(error);
        console.error(`[test-send] newsletter ${newsletter.id} to ${email} failed: ${error?.code || ''} ${error?.message}`);
        const prefix = delivered.length ? `Sent to ${delivered.join(', ')}, but stopped at ${email}. ` : '';
        return res.status(status).json({ message: `${prefix}${message}`, code: 'MAIL_SEND_FAILED', delivered });
      }
    }
    res.json({ message: `Test email sent to ${delivered.join(', ')}.`, delivered });
  } catch (error) { next(error); }
};

module.exports = { resend, previewAudience, list, sent, getOne, published, publishedOne, trackingPixel, trackClick, stats, recipients, createContact, importContacts, removeContact, tracking, groups, createGroup, updateGroup, deleteGroup, uploadImage, uploadImages, getImage, getImageAsset, deleteImage, removeDraft, save, send, sendProgress, cancelSend, testSend, listTemplates, saveTemplate, removeTemplate };