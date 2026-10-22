const crypto = require('crypto');
const os = require('os');
const pool = require('../../config/db');
const { mailer, getSenderIdentity } = require('../../config/mailer');
const { resolveSender } = require('../senderIdentity');
const automationModel = require('../../models/automationModel');
const emailLogModel = require('../../models/emailLogModel');
const scheduledEmailModel = require('../../models/scheduledEmailModel');
const { indexWorkflow, waitMs } = require('./workflow');
const { renderTemplate, getRecipientProfile, addTracking, apiOrigin } = require('./personalization');
const { resolveEmailContent, resolveAudience } = require('./content');
const { enroll } = require('./triggers');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const MAX_EMAIL_ATTEMPTS = Math.max(1, parseInt(process.env.AUTOMATION_EMAIL_MAX_ATTEMPTS || '3', 10));
const MAX_STEP_ATTEMPTS = 3;
const MAX_STEPS_PER_RUN = 100; // guards against accidental infinite loops
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600];

const retryDelay = (attempt) => RETRY_DELAYS_SECONDS[Math.min(attempt - 1, RETRY_DELAYS_SECONDS.length - 1)];

/** Renders personalised subject + HTML (with tracking) and queues it. */
const queuePersonalisedEmail = async ({ source, email, subject, html, idempotencyKey, automationId, enrollmentId, stepId, scheduledEmailId, client }) => {
  const profile = await getRecipientProfile(email);
  const token = crypto.randomUUID();
  return emailLogModel.enqueueEmail({
    source, automationId, enrollmentId, stepId, scheduledEmailId, idempotencyKey,
    recipientEmail: email,
    subject: renderTemplate(subject, profile).slice(0, 500),
    htmlContent: addTracking(renderTemplate(html, profile, { html: true }), token, apiOrigin()),
    trackingToken: token,
    maxAttempts: MAX_EMAIL_ATTEMPTS,
    client,
  });
};

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

const evaluateCondition = async (entry, enrollment) => {
  const { config } = entry.step;
  if (config.check === 'email_opened' || config.check === 'email_clicked') {
    let stepId = null;
    if (config.stepId === 'previous') stepId = entry.previousSendId;
    else if (config.stepId && config.stepId !== 'any') stepId = config.stepId;
    const kind = config.check === 'email_clicked' ? 'clicked' : 'opened';
    const verb = kind === 'clicked' ? 'clicked a link in' : 'opened';
    const target = stepId ? 'the email' : 'any email in this automation';
    if (config.stepId === 'previous' && !stepId) return { result: false, detail: 'there is no earlier email in this path to check' };
    const result = await emailLogModel.hasEngagement({ enrollmentId: enrollment.id, stepId, kind });
    return { result, detail: result ? `the contact ${verb} ${target}` : `the contact has not ${verb} ${target}` };
  }
  const profile = await getRecipientProfile(enrollment.email);
  if (config.check === 'user_activated') {
    const result = Boolean(profile.activatedAt);
    return { result, detail: result ? 'the contact has signed in' : 'the contact has not signed in yet' };
  }
  if (config.check === 'field') {
    const actual = String(profile[config.field] || '').trim().toLowerCase();
    const expected = String(config.value || '').trim().toLowerCase();
    let result = false;
    if (config.operator === 'equals') result = actual === expected;
    if (config.operator === 'not_equals') result = actual !== expected;
    if (config.operator === 'contains') result = expected ? actual.includes(expected) : false;
    const op = { equals: 'is', not_equals: 'is not', contains: 'contains' }[config.operator];
    const rule = `${config.field} ${op} "${config.value}"`;
    return { result, detail: result ? rule : `condition not met (${rule})` };
  }
  return { result: false, detail: 'unknown condition' };
};

/* ------------------------------------------------------------------ */
/* Workflow execution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Runs one enrollment forward until it has to wait, ends, or fails.
 * State is written back to automation_enrollments at the end of the run.
 */
const runEnrollment = async (enrollment, automation) => {
  const { index } = indexWorkflow(automation.workflow);
  let stepId = enrollment.currentStepId;
  const record = (entry, status, message) => automationModel.recordStepRun({
    automationId: automation.id, enrollmentId: enrollment.id,
    stepId: entry?.step.id || stepId, stepType: entry?.step.type || 'unknown', status, message,
  });
  const save = (values) => automationModel.saveEnrollmentState({
    id: enrollment.id, workerId: WORKER_ID, attempts: 0, lastError: null, nextRunAt: null, ...values,
  });

  // The previous run ended on a Wait: that wait is now over.
  if (enrollment.context?.waitStepId) {
    await automationModel.recordStepRun({
      automationId: automation.id, enrollmentId: enrollment.id, stepId: enrollment.context.waitStepId,
      stepType: 'wait', status: 'completed', message: 'Wait finished',
    });
    await pool.query(`UPDATE automation_enrollments SET context = context - 'waitStepId' WHERE id = $1`, [enrollment.id]);
  }

  for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
    if (!stepId) {
      await save({ status: 'completed', currentStepId: null });
      return 'completed';
    }
    const entry = index.get(stepId);
    if (!entry) {
      await record(null, 'failed', 'This step was removed from the workflow while the contact was waiting on it.');
      await save({ status: 'exited', currentStepId: stepId, lastError: 'Step removed from workflow' });
      return 'exited';
    }

    try {
      const { step } = entry;
      if (step.type === 'send_email') {
        const html = await resolveEmailContent(step.config);
        const queued = await queuePersonalisedEmail({
          source: 'automation', email: enrollment.email, subject: step.config.subject, html,
          idempotencyKey: `enr:${enrollment.id}:step:${step.id}`,
          automationId: automation.id, enrollmentId: enrollment.id, stepId: step.id,
        });
        await record(entry, queued.duplicate ? 'skipped' : 'completed', queued.duplicate ? 'Email was already queued for this contact' : `Queued "${step.config.name || step.config.subject}"`);
        stepId = entry.next;
      } else if (step.type === 'wait') {
        const resumeAt = new Date(Date.now() + waitMs(step.config));
        const unit = step.config.amount === 1 ? step.config.unit.replace(/s$/, '') : step.config.unit;
        await record(entry, 'waiting', `Waiting ${step.config.amount} ${unit}`);
        await pool.query(
          `UPDATE automation_enrollments SET context = context || $2::jsonb WHERE id = $1`,
          [enrollment.id, JSON.stringify({ waitStepId: step.id })]
        );
        await save({ status: 'waiting', currentStepId: entry.next, nextRunAt: resumeAt });
        return 'waiting';
      } else if (step.type === 'condition') {
        const { result, detail } = await evaluateCondition(entry, enrollment);
        await record(entry, 'completed', `${result ? 'Yes' : 'No'}, ${detail}`);
        stepId = result ? entry.yes : entry.no;
      } else if (step.type === 'end') {
        await record(entry, 'completed', 'Left the automation at End');
        await save({ status: 'completed', currentStepId: null });
        return 'completed';
      }
    } catch (error) {
      const attempts = (enrollment.attempts || 0) + 1;
      const finalFailure = attempts >= MAX_STEP_ATTEMPTS;
      await record(entry, 'failed', `${error.message}${finalFailure ? '' : ` (retrying, attempt ${attempts}/${MAX_STEP_ATTEMPTS})`}`);
      await save({
        status: finalFailure ? 'failed' : 'active',
        currentStepId: stepId,
        attempts,
        lastError: error.message,
        nextRunAt: finalFailure ? null : new Date(Date.now() + retryDelay(attempts) * 1000),
      });
      return finalFailure ? 'failed' : 'retry';
    }
  }
  await save({ status: 'failed', currentStepId: stepId, lastError: 'Too many steps in a single run' });
  return 'failed';
};

const processEnrollments = async (limit = 50) => {
  const claimed = await automationModel.claimDueEnrollments(WORKER_ID, limit);
  if (!claimed.length) return 0;
  const automationIds = [...new Set(claimed.map((e) => e.automationId))];
  const automations = new Map();
  for (const id of automationIds) automations.set(id, await automationModel.findAutomationById(id));
  for (const enrollment of claimed) {
    try {
      await runEnrollment(enrollment, automations.get(enrollment.automationId));
    } catch (error) {
      // Lock expires on its own, so the enrollment will be picked up again.
      console.error(`[automation] enrollment ${enrollment.id} crashed:`, error.message);
    }
  }
  await automationModel.touchAutomationsRun(automationIds);
  return claimed.length;
};

/* ------------------------------------------------------------------ */
/* Email sending with retry                                            */
/* ------------------------------------------------------------------ */

/** 5xx SMTP replies mean the recipient was rejected: that is a bounce, retrying will not help. */
const isPermanentRejection = (error) => {
  const code = Number(error?.responseCode);
  return code >= 550 && code <= 559;
};

// Scheduled emails carry their own sender (From name / email / Reply-To); cached briefly per scheduled email.
const scheduledSenders = new Map();
const senderFor = async (log) => {
  if (!log.scheduledEmailId) return getSenderIdentity();
  const hit = scheduledSenders.get(log.scheduledEmailId);
  if (hit && hit.until > Date.now()) return hit.headers;
  const details = await scheduledEmailModel.findScheduledSender(log.scheduledEmailId);
  const { headers } = await resolveSender(details || {});
  scheduledSenders.set(log.scheduledEmailId, { headers, until: Date.now() + 60000 });
  return headers;
};

const sendOne = async (log) => {
  try {
    const sender = await senderFor(log);
    const info = await mailer.sendMail({
      ...sender, to: log.recipientEmail, subject: log.subject, html: log.htmlContent,
      headers: { 'X-ADMS-Email-Log': String(log.id) },
    });
    const rejected = (info.rejected || []).map((e) => String(e).toLowerCase());
    if (rejected.includes(log.recipientEmail)) {
      await emailLogModel.markBounced(log.id, info.response || 'Recipient rejected by mail server');
      return 'bounced';
    }
    const accepted = (info.accepted || []).map((e) => String(e).toLowerCase()).includes(log.recipientEmail);
    await emailLogModel.markSent(log.id, { messageId: info.messageId, accepted });
    return 'sent';
  } catch (error) {
    if (isPermanentRejection(error)) {
      await emailLogModel.markBounced(log.id, error.response || error.message);
      return 'bounced';
    }
    const result = await emailLogModel.markAttemptFailed(log.id, error.message, retryDelay(log.attempts));
    return result?.status === 'failed' ? 'failed' : 'retry';
  }
};

const processEmailQueue = async (limit = 20, concurrency = 4) => {
  const claimed = await emailLogModel.claimDueEmails(limit);
  if (!claimed.length) return 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
    while (cursor < claimed.length) {
      const log = claimed[cursor];
      cursor += 1;
      await sendOne(log);
    }
  });
  await Promise.all(workers);
  const scheduledIds = [...new Set(claimed.map((l) => l.scheduledEmailId).filter(Boolean))];
  await scheduledEmailModel.refreshScheduledEmailStatus(scheduledIds);
  return claimed.length;
};

/* ------------------------------------------------------------------ */
/* Scheduled emails + scheduled-trigger automations                    */
/* ------------------------------------------------------------------ */

const processScheduledEmails = async (limit = 5) => {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = (await client.query(
        `SELECT id, name, source_type, newsletter_id, template_id, subject, recipient_type, group_id, recipient_emails
         FROM scheduled_emails WHERE status = 'scheduled' AND scheduled_at <= NOW()
         ORDER BY scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED`
      )).rows[0];
      if (!due) { await client.query('COMMIT'); break; }
      try {
        const html = await resolveEmailContent({ sourceType: due.source_type, newsletterId: due.newsletter_id, templateId: due.template_id });
        const recipients = await resolveAudience({ type: due.recipient_type, groupId: due.group_id, emails: due.recipient_emails });
        if (!recipients.length) throw new Error('No valid recipients at send time.');
        for (const email of recipients) {
          await queuePersonalisedEmail({
            source: 'scheduled', email, subject: due.subject, html,
            idempotencyKey: `sched:${due.id}:${email}`, scheduledEmailId: due.id, client,
          });
        }
        await client.query(
          `UPDATE scheduled_emails SET status = 'processing', recipient_count = $2, processed_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
          [due.id, recipients.length]
        );
      } catch (error) {
        await client.query(
          `UPDATE scheduled_emails SET status = 'failed', last_error = $2, processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [due.id, error.message]
        );
      }
      await client.query('COMMIT');
      processed += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[automation] scheduled email processing failed:', error.message);
      break;
    } finally {
      client.release();
    }
  }
  return processed;
};

/** Next occurrence (strictly in the future) of a local wall-clock time in a timezone. */
const computeNextScheduledRun = async (triggerConfig, { allowPast = false } = {}) => {
  const { localDatetime, timezone, repeat = 'none' } = triggerConfig || {};
  if (!localDatetime || !timezone) return null;
  if (repeat === 'none') {
    const row = (await pool.query(
      `SELECT ($1::timestamp AT TIME ZONE $2) AS at, ($1::timestamp AT TIME ZONE $2) > NOW() AS future`, [localDatetime, timezone]
    )).rows[0];
    return row.future || allowPast ? row.at : null;
  }
  const step = { daily: [1, 0], weekly: [7, 0], monthly: [0, 1] }[repeat];
  if (!step) return null;
  const row = (await pool.query(
    `SELECT ($1::timestamp + make_interval(days => $3 * k, months => $4 * k)) AT TIME ZONE $2 AS at
     FROM generate_series(0, 5000) k
     WHERE ($1::timestamp + make_interval(days => $3 * k, months => $4 * k)) AT TIME ZONE $2 > NOW()
     ORDER BY k LIMIT 1`, [localDatetime, timezone, step[0], step[1]]
  )).rows[0];
  return row?.at || null;
};

const processScheduledTriggers = async (limit = 5) => {
  let fired = 0;
  for (let i = 0; i < limit; i += 1) {
    let automation = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      automation = (await client.query(
        `SELECT id, name, workflow, trigger_config AS "triggerConfig", allow_reentry AS "allowReentry", next_run_at AS "nextRunAt"
         FROM automations WHERE status = 'active' AND trigger_type = 'scheduled' AND next_run_at <= NOW()
         ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED`
      )).rows[0];
      if (automation) {
        const next = await computeNextScheduledRun(automation.triggerConfig);
        // Advance the schedule inside the row lock, so the same run can never fire twice.
        await client.query(`UPDATE automations SET next_run_at = $2, last_run_at = NOW() WHERE id = $1`, [automation.id, next]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[automation] scheduled trigger failed:', error.message);
      automation = null;
    } finally {
      client.release();
    }
    if (!automation) break;

    try {
      const audience = await resolveAudience(automation.triggerConfig.audience || { type: 'all' });
      const runKey = new Date(automation.nextRunAt).toISOString();
      for (const email of audience) {
        await enroll({ ...automation, triggerType: 'scheduled' }, {
          email, dedupeKey: `scheduled:${runKey}:${email}`, context: { trigger: 'scheduled', runAt: runKey },
        });
      }
      fired += 1;
    } catch (error) {
      console.error(`[automation] scheduled trigger for automation ${automation.id} could not resolve its audience:`, error.message);
    }
  }
  return fired;
};

module.exports = {
  WORKER_ID, processEnrollments, processEmailQueue, processScheduledEmails, processScheduledTriggers,
  computeNextScheduledRun, evaluateCondition, runEnrollment, isPermanentRejection,
};
