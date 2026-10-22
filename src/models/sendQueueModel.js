const crypto = require('crypto');
const pool = require('../config/db');

/**
 * Database side of the campaign sending queue. One newsletter_sends row per send operation (its state
 * machine and content snapshot) and one newsletter_tracking row per recipient (its own status).
 * Everything the worker needs is here, so a send can resume after a restart.
 */

const ACTIVE = ['queued', 'sending', 'paused', 'cancelling'];
const RUNNABLE = ['queued', 'sending', 'cancelling'];

/**
 * Creates a queued send with its snapshot and recipient rows in one transaction.
 * Returns the new send id, or null when the idempotency key was already used.
 */
const createQueuedSend = async ({
  newsletterId, kind, audienceType, audienceLabel, groupIds = [], subject, html, contentSource = 'saved',
  fromName, fromEmail, replyTo, recipients, suppressed = [], idempotencyKey, userId, trackingOrigin = null
}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [send] } = await client.query(
      `INSERT INTO newsletter_sends (newsletter_id, kind, audience_type, audience_label, group_ids, subject, from_name, from_email, reply_to,
         recipient_count, excluded_count, status, idempotency_key, initiated_by, snapshot_subject, snapshot_html, content_source, tracking_origin)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::text, $7, $8, $9, $10, $11, 'queued', $12, $13, $6::text, $14, $15, $16)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [newsletterId, kind, audienceType, String(audienceLabel || '').slice(0, 500), JSON.stringify(groupIds), subject, fromName, fromEmail, replyTo,
        recipients.length, suppressed.length, idempotencyKey || null, userId, html, contentSource, trackingOrigin]
    );
    if (!send) { await client.query('ROLLBACK'); return null; }
    const rows = [
      ...recipients.map((r) => ({ email: r.email, name: r.name || null, status: 'pending', reason: null })),
      ...suppressed.map((r) => ({ email: r.email, name: r.name || null, status: 'suppressed', reason: r.reason }))
    ];
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await client.query(
        `INSERT INTO newsletter_tracking (newsletter_id, send_id, email, recipient_name, tracking_token, status, last_error, error_class)
 SELECT $1, $2, u.email, u.name, u.token::uuid, u.status, u.reason, CASE WHEN u.status = 'suppressed' THEN 'suppressed' END
 FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS u(email, name, token, status, reason)
 ON CONFLICT (send_id, email) DO NOTHING`,
        [newsletterId, send.id, chunk.map((r) => r.email), chunk.map((r) => r.name), chunk.map(() => crypto.randomUUID()), chunk.map((r) => r.status), chunk.map((r) => r.reason)]
      );
    }
    await client.query('COMMIT');
    return send.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const getSend = async (id) => (await pool.query(
  `SELECT s.*, n.title, n.html_content AS newsletter_html, n.subject AS newsletter_subject, n.status AS newsletter_status
   FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id WHERE s.id = $1`, [id]
)).rows[0] || null;

const findActiveForNewsletter = async (newsletterId) => (await pool.query(
  `SELECT id FROM newsletter_sends WHERE newsletter_id = $1 AND status = ANY($2) LIMIT 1`, [newsletterId, ACTIVE]
)).rows[0] || null;

const runnableSendIds = async () => (await pool.query(
  `SELECT id FROM newsletter_sends WHERE status = ANY($1) ORDER BY started_at`, [RUNNABLE]
)).rows.map((r) => r.id);

/** Moves a send between states only from the expected ones. Returns the updated row or null. */
const transition = async (id, from, to, extra = {}) => {
  const sets = ['status = $3', 'updated_at = NOW()'];
  const params = [id, from, to];
  for (const [col, value] of Object.entries(extra)) {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  return (await pool.query(
    `UPDATE newsletter_sends SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2) RETURNING *`, params
  )).rows[0] || null;
};

/**
 * Atomically claims up to `limit` due recipients of one send. SKIP LOCKED plus the status change means
 * two workers can never pick the same recipient.
 */
const claimDue = async (sendId, limit) => (await pool.query(
  `UPDATE newsletter_tracking t
   SET status = 'sending', claimed_at = NOW(), attempt_count = t.attempt_count + 1, updated_at = NOW()
   WHERE t.id IN (
     SELECT id FROM newsletter_tracking
     WHERE send_id = $1 AND (status = 'pending' OR (status = 'retry_scheduled' AND next_retry_at <= NOW()))
     ORDER BY attempt_count, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED
   )
   RETURNING t.id, t.email, t.recipient_name AS name, t.tracking_token AS "trackingToken", t.attempt_count AS "attemptCount"`,
  [sendId, limit]
)).rows;

const markAccepted = async (id, { messageId, response }) => pool.query(
  `UPDATE newsletter_tracking
   SET status = 'accepted', sent_at = COALESCE(sent_at, NOW()), last_attempt_at = NOW(), message_id = $2, provider_response = $3,
       smtp_code = 250, error_class = NULL, last_error = NULL, next_retry_at = NULL, claimed_at = NULL, updated_at = NOW()
   WHERE id = $1`,
  [id, messageId ? String(messageId).replace(/^<|>$/g, '') : null, response ? String(response).slice(0, 500) : null]
);

const markAttemptFailed = async (id, { status, errorClass, smtpCode, error, nextRetryAt = null }) => pool.query(
  `UPDATE newsletter_tracking
   SET status = $2, error_class = $3, smtp_code = $4, last_error = $5, provider_response = $5, next_retry_at = $6,
       last_attempt_at = NOW(), claimed_at = NULL, updated_at = NOW()
   WHERE id = $1`,
  [id, status, errorClass, smtpCode || null, String(error || '').slice(0, 1000), nextRetryAt]
);

/** Gives a claimed recipient back untouched (the send was paused by a system error before it was tried). */
const releaseClaim = async (id) => pool.query(
  `UPDATE newsletter_tracking SET status = 'pending', attempt_count = GREATEST(attempt_count - 1, 0), claimed_at = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'sending'`, [id]
);

/**
 * A recipient left "sending" for longer than any single SMTP attempt can take was cut off mid-send
 * (server crash or restart). The server may or may not have accepted it, so it is marked uncertain and is
 * not retried automatically.
 */
const reconcileStale = async (seconds = 120) => (await pool.query(
  `UPDATE newsletter_tracking
   SET status = 'uncertain', error_class = 'uncertain', claimed_at = NULL, updated_at = NOW(), last_attempt_at = COALESCE(last_attempt_at, claimed_at),
       last_error = 'The server stopped while this email was being sent. It may or may not have been accepted, so it was not sent again automatically.'
   WHERE status = 'sending' AND claimed_at < NOW() - ($1::int || ' seconds')::interval
   RETURNING send_id`, [seconds]
)).rows;

const COUNT_COLUMNS = `
  COUNT(*) FILTER (WHERE status <> 'suppressed')::int AS total,
  COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
  COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
  COUNT(sent_at)::int AS accepted,
  COUNT(*) FILTER (WHERE status = 'failed' AND sent_at IS NULL)::int AS failed,
  COUNT(*) FILTER (WHERE error_class = 'bounced')::int AS bounced,
  COUNT(*) FILTER (WHERE status = 'retry_scheduled')::int AS "retryScheduled",
  COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
  COUNT(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
  COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain,
  COUNT(*) FILTER (WHERE attempt_count > 0)::int AS attempted,
  COUNT(delivered_at)::int AS delivered,
  COUNT(opened_at)::int AS opened,
  COALESCE(SUM(open_count), 0)::int AS "openEvents",
  COUNT(clicked_at)::int AS clicked,
  COUNT(*) FILTER (WHERE status = 'failed' AND sent_at IS NULL AND error_class = ANY($2))::int AS "retryable"`;

const counts = async (sendId, retryableClasses) => (await pool.query(
  `SELECT ${COUNT_COLUMNS} FROM newsletter_tracking WHERE send_id = $1`, [sendId, retryableClasses]
)).rows[0];

const nextRetryAt = async (sendId) => (await pool.query(
  `SELECT MIN(next_retry_at) AS at FROM newsletter_tracking WHERE send_id = $1 AND status = 'retry_scheduled'`, [sendId]
)).rows[0].at;

/** Stores the counters on the send row too, so listings and sorting do not need to recount. */
const storeTotals = async (sendId) => pool.query(
  `UPDATE newsletter_sends s SET sent_count = c.accepted, failed_count = c.failed, updated_at = NOW()
   FROM (SELECT COUNT(sent_at)::int AS accepted, COUNT(*) FILTER (WHERE status IN ('failed', 'uncertain') AND sent_at IS NULL)::int AS failed
         FROM newsletter_tracking WHERE send_id = $1) c
   WHERE s.id = $1`, [sendId]
);

/** Recipients never attempted (or waiting for a retry) are cancelled; accepted ones keep their status. */
const cancelRemaining = async (sendId) => (await pool.query(
  `UPDATE newsletter_tracking SET status = 'cancelled', next_retry_at = NULL, updated_at = NOW(),
          last_error = CASE WHEN status = 'retry_scheduled' THEN COALESCE(last_error, '') || ' (retry cancelled)' ELSE last_error END
   WHERE send_id = $1 AND status IN ('pending', 'retry_scheduled')`, [sendId]
)).rowCount;

const reopenCancelled = async (sendId) => (await pool.query(
  `UPDATE newsletter_tracking SET status = 'pending', updated_at = NOW() WHERE send_id = $1 AND status = 'cancelled'`, [sendId]
)).rowCount;

const retryFailed = async (sendId, classes) => (await pool.query(
  `UPDATE newsletter_tracking SET status = 'pending', next_retry_at = NULL, updated_at = NOW()
   WHERE send_id = $1 AND status = 'failed' AND sent_at IS NULL AND error_class = ANY($2)`, [sendId, classes]
)).rowCount;

const findRecipient = async (sendId, trackingId) => (await pool.query(
  `SELECT id, email, CASE WHEN sent_at IS NOT NULL THEN 'accepted' ELSE status END AS status, error_class AS "errorClass", last_error AS "lastError" FROM newsletter_tracking WHERE send_id = $1 AND id = $2`,
  [sendId, trackingId]
)).rows[0] || null;

const retryRecipient = async (sendId, trackingId) => (await pool.query(
  `UPDATE newsletter_tracking SET status = 'pending', next_retry_at = NULL, updated_at = NOW()
   WHERE send_id = $1 AND id = $2 AND status IN ('failed', 'uncertain', 'cancelled') AND sent_at IS NULL RETURNING id`, [sendId, trackingId]
)).rows[0] || null;

/* ----------------------------------- reading ----------------------------------- */

const RECIPIENT_FILTERS = {
  all: "status <> 'suppressed'",
  pending: "status = 'pending'",
  sending: "status = 'sending'",
  accepted: 'sent_at IS NOT NULL',
  delivered: 'delivered_at IS NOT NULL',
  opened: 'opened_at IS NOT NULL',
  clicked: 'clicked_at IS NOT NULL',
  failed: "status = 'failed' AND sent_at IS NULL",
  bounced: "error_class = 'bounced'",
  retry: "status = 'retry_scheduled'",
  cancelled: "status = 'cancelled'",
  uncertain: "status = 'uncertain'",
  suppressed: "status = 'suppressed'"
};
const RECIPIENT_SORTS = {
  recent: 'COALESCE(last_attempt_at, claimed_at) DESC NULLS LAST, id DESC',
  status: "CASE status WHEN 'failed' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'retry_scheduled' THEN 2 WHEN 'sending' THEN 3 WHEN 'pending' THEN 4 WHEN 'cancelled' THEN 5 WHEN 'accepted' THEN 6 ELSE 7 END, id",
  attempts: 'attempt_count DESC, id',
  email: 'email ASC'
};

const listRecipients = async (sendId, { page = 1, pageSize = 25, filter = 'all', search = '', sort = 'recent' }) => {
  const where = ['send_id = $1', RECIPIENT_FILTERS[filter] || RECIPIENT_FILTERS.all];
  const params = [sendId];
  if (search) { params.push(`%${search.toLowerCase()}%`); where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(recipient_name, '')) LIKE $${params.length})`); }
  const whereSql = where.join(' AND ');
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM newsletter_tracking WHERE ${whereSql}`, params)).rows[0].n;
  params.push(pageSize, (page - 1) * pageSize);
  const order = RECIPIENT_SORTS[sort] || RECIPIENT_SORTS.recent;
  const { rows } = await pool.query(
    `SELECT id, email, recipient_name AS name, status, attempt_count AS "attemptCount", last_attempt_at AS "lastAttemptAt",
            smtp_code AS "smtpCode", error_class AS "errorClass", last_error AS "lastError", provider_response AS "providerResponse",
            sent_at AS "acceptedAt", delivered_at AS "deliveredAt", opened_at AS "openedAt", open_count AS "openCount",
            clicked_at AS "clickedAt", click_count AS "clickCount", next_retry_at AS "nextRetryAt"
     FROM newsletter_tracking WHERE ${whereSql}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows, total, page, pageSize };
};

const recentActivity = async (sendId, limit = 8) => (await pool.query(
  `SELECT id, email, status, smtp_code AS "smtpCode", error_class AS "errorClass", last_error AS "lastError",
          COALESCE(last_attempt_at, claimed_at) AS at, next_retry_at AS "nextRetryAt"
   FROM newsletter_tracking WHERE send_id = $1 AND (last_attempt_at IS NOT NULL OR status = 'sending')
   ORDER BY COALESCE(last_attempt_at, claimed_at) DESC NULLS LAST, id DESC LIMIT $2`, [sendId, limit]
)).rows;

/** Throughput of this send so far, for the estimated remaining time. */
const throughput = async (sendId) => (await pool.query(
  `SELECT COUNT(*)::int AS n, EXTRACT(EPOCH FROM (MAX(last_attempt_at) - MIN(last_attempt_at)))::float AS seconds
   FROM newsletter_tracking WHERE send_id = $1 AND last_attempt_at IS NOT NULL AND last_attempt_at > NOW() - INTERVAL '30 minutes'`, [sendId]
)).rows[0];

const activeSends = async () => (await pool.query(
  `SELECT s.id FROM newsletter_sends s
   WHERE s.status = ANY($1) OR (s.finished_at > NOW() - INTERVAL '15 minutes')
   ORDER BY s.started_at DESC LIMIT 10`, [ACTIVE]
)).rows.map((r) => r.id);

/**
 * A provider delivery event (webhook). Stored once per provider event id, so webhook retries never
 * count twice. Returns true when the event was new and applied.
 */
const applyProviderEvent = async ({ eventId, type, messageId, email, sendId, occurredAt, detail }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = messageId
      ? (await client.query(`SELECT id, send_id FROM newsletter_tracking WHERE message_id = $1 LIMIT 1`, [String(messageId).replace(/^<|>$/g, '')])).rows[0]
      : (sendId && email ? (await client.query(`SELECT id, send_id FROM newsletter_tracking WHERE send_id = $1 AND LOWER(email) = LOWER($2)`, [sendId, email])).rows[0] : null);
    if (!target) { await client.query('ROLLBACK'); return { applied: false, reason: 'unknown_message' }; }
    const inserted = await client.query(
      `INSERT INTO newsletter_events (provider_event_id, tracking_id, send_id, event_type, occurred_at, detail)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
      [eventId, target.id, target.send_id, type, occurredAt || null, detail ? String(detail).slice(0, 1000) : null]
    );
    if (!inserted.rowCount) { await client.query('ROLLBACK'); return { applied: false, reason: 'duplicate' }; }
    if (type === 'delivered') {
      await client.query(`UPDATE newsletter_tracking SET delivered_at = COALESCE(delivered_at, COALESCE($2::timestamptz, NOW())), updated_at = NOW() WHERE id = $1`, [target.id, occurredAt || null]);
    } else if (type === 'bounced') {
      await client.query(
        `UPDATE newsletter_tracking SET status = 'failed', error_class = 'bounced', bounced_at = COALESCE(bounced_at, COALESCE($2::timestamptz, NOW())),
                last_error = $3, updated_at = NOW() WHERE id = $1`,
        [target.id, occurredAt || null, detail ? `Bounced after acceptance: ${String(detail).slice(0, 900)}` : 'Bounced after the mail server accepted it']
      );
    }
    await client.query('COMMIT');
    return { applied: true, sendId: target.send_id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const anyDeliveryEvents = async () => Boolean((await pool.query(`SELECT 1 FROM newsletter_events WHERE event_type = 'delivered' LIMIT 1`)).rowCount);

/** Addresses a campaign was told do not exist (550 unknown user and similar). */
const findUnknownMailboxes = async () => new Set((await pool.query(
  `SELECT DISTINCT LOWER(email) AS email FROM newsletter_tracking WHERE status = 'failed' AND error_class IN ('mailbox_unknown', 'bounced')`
)).rows.map((r) => r.email));

module.exports = {
  ACTIVE, RUNNABLE, createQueuedSend, getSend, findActiveForNewsletter, runnableSendIds, transition, claimDue, markAccepted, markAttemptFailed, releaseClaim,
  reconcileStale, counts, nextRetryAt, storeTotals, cancelRemaining, reopenCancelled, retryFailed, findRecipient, retryRecipient,
  listRecipients, recentActivity, throughput, activeSends, applyProviderEvent, anyDeliveryEvents, findUnknownMailboxes, RECIPIENT_FILTERS
};
