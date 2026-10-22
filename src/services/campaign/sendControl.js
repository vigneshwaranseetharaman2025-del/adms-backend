const pool = require('../../config/db');
const queue = require('../../models/sendQueueModel');
const { campaignWorker } = require('./worker');
const { RETRYABLE, MANUALLY_RETRYABLE } = require('./smtpErrors');
const { trackingStatus } = require('./trackingOrigin');

const FINISHED = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'];
const webhookConfigured = () => Boolean(String(process.env.CAMPAIGN_WEBHOOK_SECRET || '').trim());

/**
 * Live state of one send, calculated from its recipient rows. Processing counts (pending, accepted,
 * failed...) and engagement counts (opened, clicked) are kept apart: they overlap and are never added up.
 */
const buildProgress = async (sendId) => {
  const send = await queue.getSend(sendId);
  if (!send) return null;
  const [c, recent, tp, nextRetryAt, deliveryEvents] = await Promise.all([
    queue.counts(sendId, [...MANUALLY_RETRYABLE]),
    queue.recentActivity(sendId, 8),
    queue.throughput(sendId),
    queue.nextRetryAt(sendId),
    queue.anyDeliveryEvents()
  ]);
  const remaining = c.pending + c.sending + c.retryScheduled;
  const processed = c.total - remaining - c.cancelled; // attempted to a final result; cancelled ones are counted apart
  const active = ['queued', 'sending'].includes(send.status);
  const rate = tp.n > 1 && tp.seconds > 0 ? tp.n / tp.seconds : null; // recipients per second, measured
  let phase = send.status;
  if (send.status === 'paused' && c.sending > 0) phase = 'pausing';
  else if (send.status === 'sending' && c.pending === 0 && c.sending === 0 && c.retryScheduled > 0) phase = 'waiting_retry';
  const started = send.started_at ? new Date(send.started_at).getTime() : null;
  const ended = send.finished_at ? new Date(send.finished_at).getTime() : Date.now();
  return {
    id: send.id,
    newsletterId: send.newsletter_id,
    title: send.title,
    kind: send.kind,
    status: send.status,
    phase,
    audienceLabel: send.audience_label,
    subject: send.snapshot_subject || send.subject,
    fromName: send.from_name,
    fromEmail: send.from_email,
    contentSource: send.content_source,
    initiatedBy: send.initiated_by,
    pauseReason: send.pause_reason,
    lastError: send.error,
    errorCode: send.error_code,
    startedAt: send.started_at,
    finishedAt: send.finished_at,
    elapsedSeconds: started ? Math.max(0, Math.round((ended - started) / 1000)) : 0,
    etaSeconds: active && rate && remaining ? Math.round((c.pending + c.sending) / rate) : null,
    nextRetryAt,
    percent: c.total ? Math.round((processed / c.total) * 100) : 100,
    counts: { ...c, remaining, processed },
    current: recent.filter((r) => r.status === 'sending').map((r) => r.email),
    recent,
    delivery: { tracked: webhookConfigured() && deliveryEvents, webhookConfigured: webhookConfigured() },
    tracking: trackingStatus(send.tracking_origin),
    actions: {
      canPause: ['queued', 'sending'].includes(send.status),
      canResume: send.status === 'paused' || (send.status === 'cancelled' && c.cancelled > 0),
      canCancel: ['queued', 'sending', 'paused'].includes(send.status),
      canRetryFailed: c.retryable > 0 && send.status !== 'cancelling'
    }
  };
};

/** Sends from before content snapshots existed get one from the campaign's saved content, when first retried. */
const ensureSnapshot = async (send) => {
  if (send.snapshot_html) return;
  await pool.query(
    `UPDATE newsletter_sends SET snapshot_html = $2, snapshot_subject = COALESCE(snapshot_subject, $3), content_source = 'saved_at_retry' WHERE id = $1 AND snapshot_html IS NULL`,
    [send.id, send.newsletter_html, send.newsletter_subject]
  );
};

const reopen = async (send) => {
  await ensureSnapshot(send);
  if (FINISHED.includes(send.status)) await queue.transition(send.id, FINISHED, 'sending', { finished_at: null, pause_reason: null });
  campaignWorker.kick(send.id);
};

const fail = (error, code) => ({ error, code });

const requestCancel = async (sendId, userId) => {
  const send = await queue.getSend(sendId);
  if (!send) return null;
  if (!['queued', 'sending', 'paused'].includes(send.status)) return fail('This send is not running, so there is nothing to cancel.', 'NOT_RUNNING');
  const moved = await queue.transition(sendId, ['queued', 'sending', 'paused'], 'cancelling', { cancel_requested_at: new Date(), cancelled_by: userId });
  if (!moved) return fail('The send changed state. Refresh and try again.', 'STATE_CHANGED');
  campaignWorker.kick(sendId); // finishes the cancellation if no runner is active (e.g. it was paused)
  return { progress: await buildProgress(sendId) };
};

const pause = async (sendId, userId) => {
  const moved = await queue.transition(sendId, ['queued', 'sending'], 'paused', { paused_at: new Date(), paused_by: userId, pause_reason: null, error_code: 'paused_by_user' });
  if (!moved) return fail('Only a send that is in progress can be paused.', 'NOT_RUNNING');
  return { progress: await buildProgress(sendId) };
};

const resume = async (sendId) => {
  const send = await queue.getSend(sendId);
  if (!send) return null;
  if (send.status === 'paused') {
    await ensureSnapshot(send);
    await queue.transition(sendId, ['paused'], 'sending', { pause_reason: null, error_code: null });
  } else if (send.status === 'cancelled') {
    const reopened = await queue.reopenCancelled(sendId);
    if (!reopened) return fail('No cancelled recipients are left to send to.', 'NOTHING_TO_RESUME');
    await reopen(send);
  } else return fail('Only a paused or cancelled send can be resumed.', 'NOT_RESUMABLE');
  campaignWorker.kick(sendId);
  return { progress: await buildProgress(sendId) };
};

/** Retries failed recipients whose error can change: temporary errors, rate limits, lost connections. */
const retryFailed = async (sendId) => {
  const send = await queue.getSend(sendId);
  if (!send) return null;
  if (send.status === 'cancelling') return fail('The send is being cancelled.', 'CANCELLING');
  const count = await queue.retryFailed(sendId, [...MANUALLY_RETRYABLE]);
  if (!count) return fail('No failed recipients can be retried. Unknown mailboxes and other permanent rejections are not retried.', 'NOTHING_TO_RETRY');
  if (send.status !== 'paused') await reopen(send);
  return { retried: count, progress: await buildProgress(sendId) };
};

/**
 * Retries one recipient. Permanent rejections and "may have been accepted" recipients need force=true,
 * because retrying them is usually pointless or may deliver a second copy.
 */
const retryRecipient = async (sendId, trackingId, { force = false } = {}) => {
  const send = await queue.getSend(sendId);
  if (!send) return null;
  const row = await queue.findRecipient(sendId, trackingId);
  if (!row) return null;
  if (row.status === 'accepted') return fail('This email was already accepted by the mail server. It was not sent again.', 'ALREADY_ACCEPTED');
  if (!['failed', 'uncertain', 'cancelled'].includes(row.status)) return fail('This recipient is not in a state that can be retried.', 'NOT_RETRYABLE');
  if (!force && row.status === 'uncertain') return fail('This email may already have been accepted. Retrying could deliver a second copy.', 'MAY_DUPLICATE');
  if (!force && ['permanent', 'mailbox_unknown', 'bounced'].includes(row.errorClass)) return fail('The mail server permanently rejected this address. Retrying will most likely fail again.', 'PERMANENT');
  await queue.retryRecipient(sendId, trackingId);
  if (send.status !== 'paused') await reopen(send);
  return { progress: await buildProgress(sendId) };
};

module.exports = { buildProgress, requestCancel, pause, resume, retryFailed, retryRecipient, RETRYABLE };
