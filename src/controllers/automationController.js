const pool = require('../config/db');
const { resolveSender, SenderError } = require('../services/senderIdentity');
const automationModel = require('../models/automationModel');
const emailLogModel = require('../models/emailLogModel');
const scheduledEmailModel = require('../models/scheduledEmailModel');
const newsletterModel = require('../models/newsletterModel');
const { validateWorkflow, countSteps, listSendSteps, exampleOnboardingWorkflow } = require('../services/automation/workflow');
const { TRIGGER_TYPES, enroll } = require('../services/automation/triggers');
const { MERGE_TAGS } = require('../services/automation/personalization');
const { computeNextScheduledRun } = require('../services/automation/engine');
const scheduler = require('../services/automation/scheduler');

const toInt = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const isValidTimezone = async (timezone) => {
  if (!timezone || timezone.length > 64) return false;
  const result = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1', [timezone]);
  return result.rows.length > 0;
};

const normalizeAudience = (audience) => {
  const type = ['all', 'group', 'contacts'].includes(audience?.type) ? audience.type : 'all';
  const emails = Array.isArray(audience?.emails)
    ? [...new Set(audience.emails.map((e) => String(e).trim().toLowerCase()).filter(isValidEmail))]
    : [];
  return { type, groupId: type === 'group' ? toInt(audience?.groupId) : null, emails: type === 'contacts' ? emails : [] };
};

/** Validates the trigger part of an automation. */
const validateTrigger = async (triggerType, rawConfig) => {
  if (!TRIGGER_TYPES.includes(triggerType)) return { error: 'Choose a valid trigger.' };
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  if (triggerType === 'email_opened' || triggerType === 'email_clicked') {
    return { config: { newsletterId: toInt(config.newsletterId) } };
  }
  if (triggerType === 'scheduled') {
    const localDatetime = String(config.localDatetime || '').slice(0, 19);
    const timezone = String(config.timezone || '').trim();
    const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(config.repeat) ? config.repeat : 'none';
    if (!LOCAL_DATETIME.test(localDatetime)) return { error: 'Choose the date and time for the scheduled trigger.' };
    if (!(await isValidTimezone(timezone))) return { error: 'Choose a valid timezone.' };
    const audience = normalizeAudience(config.audience);
    if (audience.type === 'group' && !audience.groupId) return { error: 'Choose a contact list for the scheduled trigger.' };
    if (audience.type === 'contacts' && !audience.emails.length) return { error: 'Choose at least one recipient for the scheduled trigger.' };
    return { config: { localDatetime, timezone, repeat, audience } };
  }
  return { config: {} };
};

const validateAutomationBody = async (body) => {
  const name = String(body?.name || '').trim();
  const description = String(body?.description || '').trim().slice(0, 2000);
  if (!name || name.length > 150) return { error: 'Automation name is required and must be 150 characters or fewer.' };
  const trigger = await validateTrigger(String(body?.triggerType || ''), body?.triggerConfig);
  if (trigger.error) return trigger;
  const workflowResult = validateWorkflow(body?.workflow || { steps: [] });
  if (workflowResult.error) return workflowResult;
  return {
    values: {
      name, description, triggerType: body.triggerType, triggerConfig: trigger.config,
      workflow: workflowResult.workflow, allowReentry: body?.allowReentry === true,
    },
  };
};

/** Activation is stricter than saving a draft: everything referenced must exist. */
const checkReadyToActivate = async (automation) => {
  const sendSteps = listSendSteps(automation.workflow);
  if (!sendSteps.length) return 'Add at least one Send email step before activating.';
  for (const step of sendSteps) {
    if (step.config.sourceType === 'newsletter' && !(await newsletterModel.findNewsletterById(step.config.newsletterId))) {
      return `The campaign used by "${step.config.name}" no longer exists.`;
    }
    if (step.config.sourceType === 'template' && !(await newsletterModel.findNewsletterTemplateById(step.config.templateId))) {
      return `The template used by "${step.config.name}" no longer exists.`;
    }
  }
  if (automation.triggerType === 'scheduled') {
    const next = await computeNextScheduledRun(automation.triggerConfig);
    if (!next) return 'The scheduled date and time is in the past. Choose a future time or a repeat interval.';
  }
  return null;
};

const decorate = (automation) => automation && ({
  ...automation,
  stepCount: countSteps(automation.workflow),
  nextRunAt: automation.triggerType === 'scheduled' ? automation.nextRunAt : (automation.nextEnrollmentRunAt || null),
});

/* -------------------------------- automations -------------------------------- */

const list = async (req, res, next) => {
  try { res.json((await automationModel.listAutomations()).map(decorate)); } catch (error) { next(error); }
};

const summary = async (req, res, next) => {
  try { res.json({ ...(await automationModel.getDashboardSummary()), engine: scheduler.getStatus() }); } catch (error) { next(error); }
};

const meta = async (req, res) => {
  res.json({ triggers: TRIGGER_TYPES, mergeTags: MERGE_TAGS, example: { triggerType: 'user_registered', workflow: exampleOnboardingWorkflow() } });
};

const getOne = async (req, res, next) => {
  try {
    const automation = await automationModel.findAutomationById(toInt(req.params.id));
    if (!automation) return res.status(404).json({ message: 'Automation not found.' });
    res.json(decorate(automation));
  } catch (error) { next(error); }
};

const create = async (req, res, next) => {
  try {
    const result = await validateAutomationBody(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const created = await automationModel.createAutomation({ ...result.values, nextRunAt: null, userId: req.user.id });
    res.status(201).json(decorate(await automationModel.findAutomationById(created.id)));
  } catch (error) { next(error); }
};

const update = async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const existing = await automationModel.findAutomationById(id);
    if (!existing) return res.status(404).json({ message: 'Automation not found.' });
    const result = await validateAutomationBody(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    let nextRunAt = null;
    if (existing.status === 'active') {
      const problem = await checkReadyToActivate(result.values);
      if (problem) return res.status(400).json({ message: `${problem} Pause the automation to save it as incomplete.` });
      if (result.values.triggerType === 'scheduled') nextRunAt = await computeNextScheduledRun(result.values.triggerConfig);
    } else if (existing.status === 'paused' && result.values.triggerType === 'scheduled') {
      nextRunAt = await computeNextScheduledRun(result.values.triggerConfig);
    }
    await automationModel.updateAutomation({ id, ...result.values, nextRunAt });
    res.json(decorate(await automationModel.findAutomationById(id)));
  } catch (error) { next(error); }
};

const remove = async (req, res, next) => {
  try {
    const deleted = await automationModel.deleteAutomation(toInt(req.params.id));
    if (!deleted) return res.status(404).json({ message: 'Automation not found.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

const changeStatus = (target) => async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const automation = await automationModel.findAutomationById(id);
    if (!automation) return res.status(404).json({ message: 'Automation not found.' });
    if (target === 'paused' && automation.status !== 'active') return res.status(409).json({ message: 'Only active automations can be paused.' });
    if (req.path.endsWith('/resume') && automation.status !== 'paused') return res.status(409).json({ message: 'Only paused automations can be resumed.' });
    let nextRunAt = automation.triggerType === 'scheduled' ? automation.nextRunAt : null;
    if (target === 'active') {
      const problem = await checkReadyToActivate(automation);
      if (problem) return res.status(400).json({ message: problem });
      if (automation.triggerType === 'scheduled') nextRunAt = await computeNextScheduledRun(automation.triggerConfig);
    }
    await automationModel.setAutomationStatus(id, target, nextRunAt);
    if (target === 'active') scheduler.nudge();
    res.json(decorate(await automationModel.findAutomationById(id)));
  } catch (error) { next(error); }
};

const manualEnroll = async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    const automation = await automationModel.findAutomationById(id);
    if (!automation) return res.status(404).json({ message: 'Automation not found.' });
    if (automation.status !== 'active') return res.status(409).json({ message: 'Activate the automation before adding contacts to it.' });
    const result = await enroll({ ...automation, allowReentry: true }, {
      email, dedupeKey: `manual:${Date.now()}:${email}`, context: { trigger: 'manual', addedBy: req.user.id },
    });
    if (!result) return res.status(409).json({ message: `${email} is already going through this automation.` });
    scheduler.nudge();
    res.status(201).json(result);
  } catch (error) { next(error); }
};

const enrollments = async (req, res, next) => {
  try {
    const page = Math.max(toInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(toInt(req.query.pageSize) || 20, 1), 100);
    const status = ['active', 'waiting', 'completed', 'failed', 'exited'].includes(req.query.status) ? req.query.status : null;
    res.json(await automationModel.listEnrollments(toInt(req.params.id), { page, pageSize, status }));
  } catch (error) { next(error); }
};

const enrollmentSteps = async (req, res, next) => {
  try { res.json(await automationModel.listEnrollmentSteps(toInt(req.params.id), toInt(req.params.enrollmentId))); } catch (error) { next(error); }
};

const stepStats = async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const [emails, reach] = await Promise.all([automationModel.listStepEmailStats(id), automationModel.listStepReach(id)]);
    res.json({ emails, reach });
  } catch (error) { next(error); }
};

const errors = async (req, res, next) => {
  try { res.json(await automationModel.listAutomationErrors(toInt(req.params.id))); } catch (error) { next(error); }
};

/* ------------------------------ scheduled emails ------------------------------ */

const validateScheduledBody = async (body) => {
  const name = String(body?.name || '').trim();
  const subject = String(body?.subject || '').trim();
  const sourceType = ['newsletter', 'template'].includes(body?.sourceType) ? body.sourceType : null;
  const localDatetime = String(body?.localDatetime || '').slice(0, 19);
  const timezone = String(body?.timezone || '').trim();
  if (!name || name.length > 150) return { error: 'Give the scheduled email a name (150 characters or fewer).' };
  if (!subject || subject.length > 255) return { error: 'Subject is required and must be 255 characters or fewer.' };
  if (!sourceType) return { error: 'Choose a campaign or template to send.' };
  const newsletterId = sourceType === 'newsletter' ? toInt(body.newsletterId) : null;
  const templateId = sourceType === 'template' ? toInt(body.templateId) : null;
  if (sourceType === 'newsletter' && !(newsletterId && await newsletterModel.findNewsletterById(newsletterId))) return { error: 'Choose an existing campaign.' };
  if (sourceType === 'template' && !(templateId && await newsletterModel.findNewsletterTemplateById(templateId))) return { error: 'Choose an existing template.' };
  const audience = normalizeAudience({ type: body?.recipientType, groupId: body?.groupId, emails: body?.recipientEmails });
  if (audience.type === 'group' && !audience.groupId) return { error: 'Choose a contact list.' };
  if (audience.type === 'contacts' && !audience.emails.length) return { error: 'Choose at least one recipient.' };
  if (!LOCAL_DATETIME.test(localDatetime)) return { error: 'Choose a date and time.' };
  if (!(await isValidTimezone(timezone))) return { error: 'Choose a valid timezone.' };
  const future = (await pool.query('SELECT ($1::timestamp AT TIME ZONE $2) > NOW() AS ok', [localDatetime, timezone])).rows[0].ok;
  if (!future) return { error: 'The scheduled time has already passed in that timezone.' };
  // Same sender rules as campaigns: only the configured address or an address at a verified domain.
  let sender;
  try {
    sender = await resolveSender({ fromName: body?.fromName, fromEmail: body?.fromEmail, replyTo: body?.replyTo });
  } catch (error) {
    if (error instanceof SenderError) return { error: error.message };
    throw error;
  }
  return {
    values: {
      name, subject, sourceType, newsletterId, templateId, recipientType: audience.type, groupId: audience.groupId,
      recipientEmails: audience.emails, localDatetime, timezone,
      fromName: sender.name, fromEmail: sender.email, replyTo: sender.replyTo,
    },
  };
};

const listScheduled = async (req, res, next) => {
  try {
    const status = ['scheduled', 'processing', 'sent', 'failed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    res.json(await scheduledEmailModel.listScheduledEmails({ status }));
  } catch (error) { next(error); }
};

const createScheduled = async (req, res, next) => {
  try {
    const result = await validateScheduledBody(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const created = await scheduledEmailModel.createScheduledEmail({ ...result.values, userId: req.user.id });
    res.status(201).json(await scheduledEmailModel.findScheduledEmailById(created.id));
  } catch (error) { next(error); }
};

const updateScheduled = async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const result = await validateScheduledBody(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const updated = await scheduledEmailModel.updateScheduledEmail(id, result.values);
    if (!updated) return res.status(409).json({ message: 'Only emails that have not started sending can be edited.' });
    res.json(await scheduledEmailModel.findScheduledEmailById(id));
  } catch (error) { next(error); }
};

const cancelScheduled = async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const cancelled = await scheduledEmailModel.cancelScheduledEmail(id);
    if (!cancelled) return res.status(409).json({ message: 'This email has already started sending and can no longer be cancelled.' });
    res.json(await scheduledEmailModel.findScheduledEmailById(id));
  } catch (error) { next(error); }
};

const deleteScheduled = async (req, res, next) => {
  try {
    const deleted = await scheduledEmailModel.deleteScheduledEmail(toInt(req.params.id));
    if (!deleted) return res.status(409).json({ message: 'Cancel the scheduled email before deleting it.' });
    res.status(204).end();
  } catch (error) { next(error); }
};

/* --------------------------------- email logs --------------------------------- */

const listLogs = async (req, res, next) => {
  try {
    const page = Math.max(toInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(toInt(req.query.pageSize) || 25, 1), 100);
    res.json(await emailLogModel.listEmailLogs({
      page, pageSize, status: req.query.status, source: req.query.source,
      automationId: toInt(req.query.automationId), scheduledEmailId: toInt(req.query.scheduledEmailId),
      stepId: req.query.stepId ? String(req.query.stepId).slice(0, 64) : null,
      search: String(req.query.search || '').trim().slice(0, 100),
    }));
  } catch (error) { next(error); }
};

/** Status cards for what is on screen: takes the same source / scope / search filters as the list. */
const logSummary = async (req, res, next) => {
  try {
    res.json(await emailLogModel.getEmailLogSummary({
      source: req.query.source, automationId: toInt(req.query.automationId), scheduledEmailId: toInt(req.query.scheduledEmailId),
      stepId: req.query.stepId ? String(req.query.stepId).slice(0, 64) : null,
      search: String(req.query.search || '').trim().slice(0, 100),
    }));
  } catch (error) { next(error); }
};

/** One row per scheduled email or automation step, instead of one row per recipient. */
const listLogGroups = async (req, res, next) => {
  try {
    const page = Math.max(toInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(toInt(req.query.pageSize) || 10, 1), 100);
    res.json(await emailLogModel.listEmailLogGroups({
      page, pageSize, source: req.query.source, status: req.query.status,
      search: String(req.query.search || '').trim().slice(0, 100),
    }));
  } catch (error) { next(error); }
};

/** Removes tracking so viewing a log in the admin UI never counts as an open/click. */
const stripTracking = (html) => String(html || '')
  .replace(/<img[^>]+\/api\/automations\/track\/[^>]+>/gi, '')
  .replace(/href="[^"]*\/api\/automations\/click\/[^"?]+\?u=([^"]+)"/gi, (m, url) => `href="${decodeURIComponent(url)}"`);

const logPreview = async (req, res, next) => {
  try {
    const log = await emailLogModel.findEmailLogPreview(toInt(req.params.id));
    if (!log) return res.status(404).json({ message: 'Email log not found.' });
    res.json({ ...log, htmlContent: stripTracking(log.htmlContent) });
  } catch (error) { next(error); }
};

const retryLog = async (req, res, next) => {
  try {
    const log = await emailLogModel.requeueEmail(toInt(req.params.id));
    if (!log) return res.status(409).json({ message: 'Only failed emails can be retried.' });
    if (log.scheduledEmailId) await scheduledEmailModel.refreshScheduledEmailStatus([log.scheduledEmailId]);
    scheduler.nudge();
    res.json({ message: 'Email queued for another attempt.' });
  } catch (error) { next(error); }
};

/* ------------------------- tracking, webhook, engine -------------------------- */

const isUuid = (token) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(token || ''));

const trackOpen = async (req, res, next) => {
  try {
    if (isUuid(req.params.token)) await emailLogModel.markOpenedByToken(req.params.token);
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
  } catch (error) { next(error); }
};

const trackClick = async (req, res, next) => {
  try {
    const target = String(req.query.u || '');
    const safeTarget = /^https?:\/\//i.test(target) ? target : '/';
    if (isUuid(req.params.token)) await emailLogModel.markClickedByToken(req.params.token);
    res.redirect(302, safeTarget);
  } catch (error) { next(error); }
};

/**
 * Optional delivery/bounce webhook for providers (SES/SendGrid relays, DSN processors).
 * Body: { event: 'delivered'|'bounced', token?: trackingToken, messageId?: smtpMessageId, reason? }
 */
const emailEvent = async (req, res, next) => {
  try {
    const secret = process.env.EMAIL_WEBHOOK_SECRET;
    if (!secret || req.get('x-webhook-secret') !== secret) return res.status(403).json({ message: 'Invalid webhook secret.' });
    const event = String(req.body?.event || '');
    const token = isUuid(req.body?.token) ? req.body.token : null;
    const messageId = req.body?.messageId ? String(req.body.messageId).slice(0, 500) : null;
    if (!['delivered', 'bounced'].includes(event) || (!token && !messageId)) {
      return res.status(400).json({ message: 'Send event (delivered|bounced) and a token or messageId.' });
    }
    const updated = await emailLogModel.applyExternalEvent({ token, messageId, event, reason: req.body?.reason });
    if (!updated) return res.status(404).json({ message: 'No matching email log.' });
    res.json({ ok: true, id: updated.id });
  } catch (error) { next(error); }
};

const engineStatus = async (req, res) => res.json(scheduler.getStatus());

const engineRun = async (req, res, next) => {
  try {
    await scheduler.tick();
    res.json(scheduler.getStatus());
  } catch (error) { next(error); }
};

module.exports = {
  listLogGroups,
  list, summary, meta, getOne, create, update, remove,
  activate: changeStatus('active'), pause: changeStatus('paused'), resume: changeStatus('active'),
  manualEnroll, enrollments, enrollmentSteps, stepStats, errors,
  listScheduled, createScheduled, updateScheduled, cancelScheduled, deleteScheduled,
  listLogs, logSummary, logPreview, retryLog,
  trackOpen, trackClick, emailEvent, engineStatus, engineRun,
};
