const pool = require('../config/db');

const LOG_FIELDS = `l.id, l.source, l.automation_id AS "automationId", l.enrollment_id AS "enrollmentId", l.step_id AS "stepId",
  l.scheduled_email_id AS "scheduledEmailId", l.recipient_email AS "recipientEmail", l.subject, l.status, l.attempts,
  l.max_attempts AS "maxAttempts", l.next_attempt_at AS "nextAttemptAt", l.last_error AS "lastError", l.message_id AS "messageId",
  l.open_count AS "openCount", l.click_count AS "clickCount", l.queued_at AS "queuedAt", l.sent_at AS "sentAt",
  l.delivered_at AS "deliveredAt", l.opened_at AS "openedAt", l.clicked_at AS "clickedAt", l.failed_at AS "failedAt",
  l.bounced_at AS "bouncedAt", l.updated_at AS "updatedAt"`;

/** Idempotent enqueue: the same idempotency key is only ever queued once. */
const enqueueEmail = async ({
  source, automationId = null, enrollmentId = null, stepId = null, scheduledEmailId = null,
  idempotencyKey, recipientEmail, subject, htmlContent, trackingToken, maxAttempts = 3, client = pool,
}) => {
  const result = await client.query(
    `INSERT INTO email_logs (source, automation_id, enrollment_id, step_id, scheduled_email_id, idempotency_key,
       recipient_email, subject, html_content, tracking_token, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [source, automationId, enrollmentId, stepId, scheduledEmailId, idempotencyKey, recipientEmail, subject, htmlContent, trackingToken, maxAttempts]
  );
  return { id: result.rows[0]?.id || null, duplicate: !result.rows.length };
};

/** Claims queued emails that are due. Emails of paused automations wait until resumed. */
const claimDueEmails = async (limit = 20, lockSeconds = 120) => (await pool.query(
  `UPDATE email_logs l SET locked_until = NOW() + make_interval(secs => $2), attempts = l.attempts + 1, updated_at = NOW()
   WHERE l.id IN (
     SELECT q.id FROM email_logs q
     LEFT JOIN automations a ON a.id = q.automation_id
     WHERE q.status = 'queued' AND q.next_attempt_at <= NOW()
       AND (q.locked_until IS NULL OR q.locked_until < NOW())
       AND (q.automation_id IS NULL OR a.status = 'active')
     ORDER BY q.next_attempt_at, q.id
     LIMIT $1
     FOR UPDATE OF q SKIP LOCKED
   )
   RETURNING l.id, l.source, l.automation_id AS "automationId", l.scheduled_email_id AS "scheduledEmailId",
     l.recipient_email AS "recipientEmail", l.subject, l.html_content AS "htmlContent", l.attempts, l.max_attempts AS "maxAttempts"`,
  [limit, lockSeconds]
)).rows;

/**
 * The mail server accepted the message. That is not proof of delivery: "delivered" is only set by a
 * delivery event from the provider (applyExternalEvent). `accepted` is kept for callers but no longer
 * turns into a delivery.
 */
const markSent = async (id, { messageId }) => pool.query(
  `UPDATE email_logs SET status = 'sent', sent_at = NOW(),
     message_id = $2, last_error = NULL, locked_until = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'queued'`, [id, messageId || null]
);

const markBounced = async (id, error) => pool.query(
  `UPDATE email_logs SET status = 'bounced', bounced_at = NOW(), last_error = $2, locked_until = NULL, updated_at = NOW()
   WHERE id = $1`, [id, String(error || 'Rejected by recipient server').slice(0, 2000)]
);

/** Retries with backoff while attempts remain, then marks failed. */
const markAttemptFailed = async (id, error, retryDelaySeconds) => (await pool.query(
  `UPDATE email_logs SET
     status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
     failed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE failed_at END,
     next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE NOW() + make_interval(secs => $3) END,
     last_error = $2, locked_until = NULL, updated_at = NOW()
   WHERE id = $1 RETURNING status`, [id, String(error || 'Unknown error').slice(0, 2000), retryDelaySeconds]
)).rows[0] || null;

/** Opens never downgrade a clicked email; returns the row so triggers/conditions can react. */
const markOpenedByToken = async (token) => (await pool.query(
  `UPDATE email_logs SET opened_at = COALESCE(opened_at, NOW()), open_count = open_count + 1,
     status = CASE WHEN status IN ('sent', 'delivered') THEN 'opened' ELSE status END, updated_at = NOW()
   WHERE tracking_token = $1 AND status NOT IN ('queued', 'failed')
   RETURNING id, automation_id AS "automationId", recipient_email AS "recipientEmail"`, [token]
)).rows[0] || null;

const markClickedByToken = async (token) => (await pool.query(
  `UPDATE email_logs SET opened_at = COALESCE(opened_at, NOW()), open_count = GREATEST(open_count, 1),
     clicked_at = COALESCE(clicked_at, NOW()), click_count = click_count + 1,
     status = CASE WHEN status IN ('sent', 'delivered', 'opened') THEN 'clicked' ELSE status END, updated_at = NOW()
   WHERE tracking_token = $1 AND status NOT IN ('queued', 'failed')
   RETURNING id, automation_id AS "automationId", recipient_email AS "recipientEmail"`, [token]
)).rows[0] || null;

/** Provider webhook / DSN events, matched by tracking token or SMTP message id. */
const applyExternalEvent = async ({ token, messageId, event, reason }) => {
  const match = token ? 'tracking_token::text = $1' : 'message_id = $1';
  const key = token || messageId;
  if (event === 'delivered') {
    return (await pool.query(
      `UPDATE email_logs SET delivered_at = COALESCE(delivered_at, NOW()),
         status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END, updated_at = NOW()
       WHERE ${match} RETURNING id`, [key]
    )).rows[0] || null;
  }
  if (event === 'bounced') {
    return (await pool.query(
      `UPDATE email_logs SET status = 'bounced', bounced_at = NOW(), last_error = COALESCE($2, 'Bounced'), updated_at = NOW()
       WHERE ${match} RETURNING id`, [key, reason ? String(reason).slice(0, 2000) : null]
    )).rows[0] || null;
  }
  return null;
};

const hasEngagement = async ({ enrollmentId, stepId, kind }) => {
  const column = kind === 'clicked' ? 'clicked_at' : 'opened_at';
  const params = [enrollmentId];
  let stepFilter = '';
  if (stepId) { params.push(stepId); stepFilter = ' AND step_id = $2'; }
  const result = await pool.query(
    `SELECT 1 FROM email_logs WHERE enrollment_id = $1${stepFilter} AND ${column} IS NOT NULL LIMIT 1`, params
  );
  return result.rows.length > 0;
};

const LOG_STATUSES = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced'];

/** WHERE clause shared by the log list, the status cards and the grouped view, so they always agree. */
const buildFilters = ({ status, source, automationId, scheduledEmailId, stepId, search } = {}, params = []) => {
  const where = [];
  // Milestone filters match the cumulative summary counts: "sent" includes emails that were later opened.
  const MILESTONES = { sent: 'l.sent_at', delivered: 'l.delivered_at', opened: 'l.opened_at', clicked: 'l.clicked_at' };
  if (MILESTONES[status]) where.push(`${MILESTONES[status]} IS NOT NULL`);
  else if (status && LOG_STATUSES.includes(status)) { params.push(status); where.push(`l.status = $${params.length}`); }
  if (source && ['automation', 'scheduled'].includes(source)) { params.push(source); where.push(`l.source = $${params.length}`); }
  if (automationId) { params.push(automationId); where.push(`l.automation_id = $${params.length}`); }
  if (scheduledEmailId) { params.push(scheduledEmailId); where.push(`l.scheduled_email_id = $${params.length}`); }
  if (stepId) { params.push(String(stepId)); where.push(`l.step_id = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`(LOWER(l.recipient_email) LIKE $${params.length} OR LOWER(l.subject) LIKE $${params.length})`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
};

const listEmailLogs = async ({ page = 1, pageSize = 25, ...filters }) => {
  const { whereSql, params } = buildFilters(filters);
  const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM email_logs l ${whereSql}`, params)).rows[0].total;
  params.push(pageSize, (page - 1) * pageSize);
  const items = (await pool.query(
    `SELECT ${LOG_FIELDS}, a.name AS "automationName", s.name AS "scheduledEmailName"
     FROM email_logs l
     LEFT JOIN automations a ON a.id = l.automation_id
     LEFT JOIN scheduled_emails s ON s.id = l.scheduled_email_id
     ${whereSql}
     ORDER BY l.queued_at DESC, l.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  )).rows;
  return { items, total, page, pageSize };
};

const SUMMARY_COLUMNS = `COUNT(*)::int AS total,
     COUNT(*) FILTER (WHERE l.status = 'queued')::int AS queued,
     COUNT(*) FILTER (WHERE l.sent_at IS NOT NULL)::int AS sent,
     COUNT(*) FILTER (WHERE l.delivered_at IS NOT NULL)::int AS delivered,
     COUNT(*) FILTER (WHERE l.opened_at IS NOT NULL)::int AS opened,
     COUNT(*) FILTER (WHERE l.clicked_at IS NOT NULL)::int AS clicked,
     COUNT(*) FILTER (WHERE l.status = 'failed')::int AS failed,
     COUNT(*) FILTER (WHERE l.status = 'bounced')::int AS bounced`;

/** Status cards for the current view: same source / scope / search filters as the list (not the status card itself). */
const getEmailLogSummary = async (filters = {}) => {
  const { whereSql, params } = buildFilters({ ...filters, status: undefined });
  return (await pool.query(`SELECT ${SUMMARY_COLUMNS} FROM email_logs l ${whereSql}`, params)).rows[0];
};

const GROUP_KEY = `CASE WHEN l.scheduled_email_id IS NOT NULL THEN 'scheduled:' || l.scheduled_email_id
                       ELSE 'automation:' || COALESCE(l.automation_id::text, '0') || ':' || COALESCE(l.step_id, '') END`;
const GROUP_STATUS = {
  queued: 'g.queued > 0', sent: 'g.sent > 0', delivered: 'g.delivered > 0', opened: 'g.opened > 0',
  clicked: 'g.clicked > 0', failed: 'g.failed > 0', bounced: 'g.bounced > 0'
};

/**
 * One row per send: a scheduled email, or one step of an automation. The recipient rows behind each
 * group are listed with listEmailLogs({ scheduledEmailId } | { automationId, stepId }).
 * search matches the group name or subject, or any recipient in it.
 */
const listEmailLogGroups = async ({ page = 1, pageSize = 10, source, search, status }) => {
  const params = [];
  const inner = [];
  if (source && ['automation', 'scheduled'].includes(source)) { params.push(source); inner.push(`l.source = $${params.length}`); }
  const outer = [];
  if (GROUP_STATUS[status]) outer.push(GROUP_STATUS[status]);
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const p = `$${params.length}`;
    outer.push(`(LOWER(COALESCE(s.name, a.name, '')) LIKE ${p} OR LOWER(COALESCE(g.subject, '')) LIKE ${p}
                 OR g.key IN (SELECT ${GROUP_KEY} FROM email_logs l WHERE LOWER(l.recipient_email) LIKE ${p}))`);
  }
  const base = `
    WITH g AS (
      SELECT ${GROUP_KEY} AS key, MIN(l.source) AS source, l.scheduled_email_id, l.automation_id, l.step_id,
             ${SUMMARY_COLUMNS},
             MIN(l.queued_at) AS first_queued_at, MAX(l.queued_at) AS last_queued_at, MAX(l.sent_at) AS last_sent_at,
             (ARRAY_AGG(l.subject ORDER BY l.id DESC))[1] AS subject
      FROM email_logs l ${inner.length ? `WHERE ${inner.join(' AND ')}` : ''}
      GROUP BY 1, 3, 4, 5
    )
    SELECT g.*, s.name AS scheduled_name, s.status AS scheduled_status, s.scheduled_at, s.timezone, s.recipient_type,
           a.name AS automation_name
    FROM g
    LEFT JOIN scheduled_emails s ON s.id = g.scheduled_email_id
    LEFT JOIN automations a ON a.id = g.automation_id
    ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}`;
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${base}) x`, params)).rows[0].n;
  params.push(pageSize, (page - 1) * pageSize);
  const rows = (await pool.query(`${base} ORDER BY g.last_queued_at DESC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  const items = rows.map((r) => ({
    key: r.key,
    source: r.source,
    scheduledEmailId: r.scheduled_email_id,
    automationId: r.automation_id,
    stepId: r.step_id,
    name: r.scheduled_name || r.automation_name || (r.scheduled_email_id ? 'Deleted scheduled email' : 'Deleted automation'),
    subject: r.subject,
    scheduledStatus: r.scheduled_status,
    scheduledAt: r.scheduled_at,
    timezone: r.timezone,
    recipientType: r.recipient_type,
    firstQueuedAt: r.first_queued_at,
    lastQueuedAt: r.last_queued_at,
    lastSentAt: r.last_sent_at,
    counts: { total: r.total, queued: r.queued, sent: r.sent, delivered: r.delivered, opened: r.opened, clicked: r.clicked, failed: r.failed, bounced: r.bounced }
  }));
  return { items, total, page, pageSize };
};

/** Manual retry of a failed email from the UI. */
const requeueEmail = async (id) => (await pool.query(
  `UPDATE email_logs SET status = 'queued', attempts = 0, next_attempt_at = NOW(), failed_at = NULL,
     locked_until = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'failed' RETURNING id, automation_id AS "automationId", scheduled_email_id AS "scheduledEmailId"`, [id]
)).rows[0] || null;

const findEmailLogPreview = async (id) => (await pool.query(
  `SELECT ${LOG_FIELDS}, l.html_content AS "htmlContent" FROM email_logs l WHERE l.id = $1`, [id]
)).rows[0] || null;

module.exports = {
  LOG_STATUSES, enqueueEmail, claimDueEmails, markSent, markBounced, markAttemptFailed, markOpenedByToken,
  markClickedByToken, applyExternalEvent, hasEngagement, listEmailLogs, listEmailLogGroups, getEmailLogSummary, requeueEmail, findEmailLogPreview,
};
