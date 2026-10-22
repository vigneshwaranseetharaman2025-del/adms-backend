const pool = require('../config/db');

const tableExists = async (name) => Boolean((await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t);

const SEND_FIELDS = `s.id, s.newsletter_id AS "newsletterId", s.kind, s.audience_type AS "audienceType", s.audience_label AS "audienceLabel",
  s.group_ids AS "groupIds", s.subject, s.from_name AS "fromName", s.from_email AS "fromEmail", s.reply_to AS "replyTo",
  s.recipient_count AS "recipientCount", s.excluded_count AS "excludedCount", s.sent_count AS "sentCount", s.failed_count AS "failedCount",
  s.status, s.error, s.initiated_by AS "initiatedBy", s.started_at AS "startedAt", s.finished_at AS "finishedAt",
  s.pause_reason AS "pauseReason", s.content_source AS "contentSource"`;

const createSend = async ({ newsletterId, kind, audienceType, audienceLabel, groupIds = [], subject, fromName, fromEmail, replyTo, recipientCount, excludedCount = 0, idempotencyKey, userId }) => {
  const { rows: [row] } = await pool.query(
    `INSERT INTO newsletter_sends (newsletter_id, kind, audience_type, audience_label, group_ids, subject, from_name, from_email, reply_to,
       recipient_count, excluded_count, status, idempotency_key, initiated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, 'sending', $12, $13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [newsletterId, kind, audienceType, String(audienceLabel || '').slice(0, 500), JSON.stringify(groupIds), subject, fromName, fromEmail, replyTo, recipientCount, excludedCount, idempotencyKey || null, userId]
  );
  return row ? row.id : null;
};

const findSendByKey = async (key) => (await pool.query(`SELECT ${SEND_FIELDS} FROM newsletter_sends s WHERE s.idempotency_key = $1`, [key])).rows[0] || null;

const updateSendProgress = async (id, sentCount) => pool.query('UPDATE newsletter_sends SET sent_count = $2 WHERE id = $1', [id, sentCount]);

const finishSend = async (id, { status, sentCount, failedCount, error = null }) => pool.query(
  `UPDATE newsletter_sends SET status = $2, sent_count = $3, failed_count = $4, error = $5, finished_at = NOW() WHERE id = $1`,
  [id, status, sentCount, failedCount, error ? String(error).slice(0, 1000) : null]
);

/** Addresses whose automated email hard-bounced: never sent to again by campaigns. */
const findBouncedEmails = async () => {
  if (!(await tableExists('email_logs'))) return new Set();
  const { rows } = await pool.query(`SELECT DISTINCT LOWER(recipient_email) AS email FROM email_logs WHERE status = 'bounced' OR bounced_at IS NOT NULL`);
  return new Set(rows.map((r) => r.email));
};

/* ----------------------------------- reports ----------------------------------- */

const SORTS = {
  started_desc: 's.started_at DESC, s.id DESC',
  started_asc: 's.started_at ASC, s.id ASC',
  name_asc: 'LOWER(n.title) ASC, s.started_at DESC',
  recipients_desc: 's.recipient_count DESC, s.started_at DESC',
  opens_desc: 'opened DESC, s.started_at DESC'
};

const STATS_JOIN = `LEFT JOIN LATERAL (
    SELECT COUNT(t.sent_at)::int AS accepted,
           COUNT(*) FILTER (WHERE t.status = 'failed' AND t.sent_at IS NULL)::int AS failed,
           COUNT(*) FILTER (WHERE t.error_class = 'bounced')::int AS bounced,
           COUNT(t.delivered_at)::int AS delivered,
           COUNT(*) FILTER (WHERE t.status IN ('pending', 'sending', 'retry_scheduled'))::int AS queued,
           COUNT(*) FILTER (WHERE t.status = 'cancelled')::int AS cancelled,
           COUNT(*) FILTER (WHERE t.status = 'uncertain')::int AS uncertain,
           COUNT(*) FILTER (WHERE t.status = 'suppressed')::int AS suppressed,
           COUNT(t.opened_at)::int AS opened,
           COALESCE(SUM(t.open_count), 0)::int AS "openEvents",
           COUNT(t.clicked_at)::int AS clicked,
           COUNT(*) FILTER (WHERE t.status <> 'suppressed')::int AS tracked
    FROM newsletter_tracking t WHERE t.send_id = s.id
  ) st ON TRUE`;

/** Every send operation (original sends and resends) with its own numbers. */
const listSends = async ({ page = 1, pageSize = 10, search = '', status = '', kind = '', sort = 'started_desc', newsletterId = null }) => {
  const params = [];
  const where = [];
  if (search) { params.push(`%${search.toLowerCase()}%`); where.push(`(LOWER(n.title) LIKE $${params.length} OR LOWER(COALESCE(s.subject, n.subject)) LIKE $${params.length})`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`s.kind = $${params.length}`); }
  if (newsletterId) { params.push(newsletterId); where.push(`s.newsletter_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id ${whereSql}`, params)).rows[0].total;
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT ${SEND_FIELDS}, n.title, n.subject AS "campaignSubject", n.is_blog AS "isBlog", n.status AS "campaignStatus",
            COALESCE(NULLIF(TRIM(cu.full_name), ''), cu.username) AS "createdByName",
            COALESCE(NULLIF(TRIM(iu.full_name), ''), iu.username) AS "initiatedByName",
            st.accepted, st.failed AS "failedRecipients", st.bounced, st.delivered, st.queued, st.cancelled, st.uncertain, st.suppressed, st.opened, st."openEvents", st.clicked, st.tracked,
            (SELECT COUNT(*)::int FROM newsletter_sends r WHERE r.newsletter_id = s.newsletter_id AND r.kind = 'resend') AS "resendCount",
            (SELECT o.id FROM newsletter_sends o WHERE o.newsletter_id = s.newsletter_id AND o.kind = 'original' ORDER BY o.started_at LIMIT 1) AS "originalSendId"
     FROM newsletter_sends s
     JOIN newsletters n ON n.id = s.newsletter_id
     LEFT JOIN users cu ON cu.id = n.created_by
     LEFT JOIN users iu ON iu.id = s.initiated_by
     ${STATS_JOIN}
     ${whereSql}
     ORDER BY ${SORTS[sort] || SORTS.started_desc}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows, total, page, pageSize };
};

const getSend = async (id) => {
  const { rows: [send] } = await pool.query(
    `SELECT ${SEND_FIELDS}, n.title, n.subject AS "campaignSubject", COALESCE(s.snapshot_html, n.html_content) AS "htmlContent",
            COALESCE(NULLIF(TRIM(iu.full_name), ''), iu.username) AS "initiatedByName", st.accepted, st.failed AS "failedRecipients", st.bounced, st.delivered, st.queued, st.cancelled, st.uncertain, st.suppressed, st.opened, st."openEvents", st.clicked, st.tracked
     FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id
     LEFT JOIN users iu ON iu.id = s.initiated_by
     ${STATS_JOIN}
     WHERE s.id = $1`,
    [id]
  );
  if (!send) return null;
  const { rows: recipients } = await pool.query(
    `SELECT id, email, status, sent_at AS "sentAt", opened_at AS "openedAt", open_count AS "openCount", clicked_at AS "clickedAt", click_count AS "clickCount",
            last_error AS "lastError", smtp_code AS "smtpCode"
     FROM newsletter_tracking WHERE send_id = $1 ORDER BY opened_at DESC NULLS LAST, email LIMIT 200`, [id]
  );
  const { rows: related } = await pool.query(
    `SELECT ${SEND_FIELDS}, COALESCE(NULLIF(TRIM(iu.full_name), ''), iu.username) AS "initiatedByName"
     FROM newsletter_sends s LEFT JOIN users iu ON iu.id = s.initiated_by
     WHERE s.newsletter_id = $1 ORDER BY s.started_at`, [send.newsletterId]
  );
  return { ...send, recipients, related };
};

/* ----------------------------------- dashboard ----------------------------------- */

/**
 * Real numbers only. Campaign emails record "accepted by the mail server", opens and clicks; delivery
 * confirmations and bounces exist only for automated/scheduled emails whose provider reports them.
 */
const getDashboard = async ({ days = 30 } = {}) => {
  const hasLogs = await tableExists('email_logs');
  const hasScheduled = await tableExists('scheduled_emails');
  const hasTemplates = await tableExists('newsletter_templates');
  const since = `NOW() - ($1::int || ' days')::interval`;

  const [campaigns, campaignEmails, logEmails, scheduled, templates, contacts] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts FROM newsletters`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE t.sent_at IS NOT NULL)::int AS sent,
                       COUNT(*) FILTER (WHERE t.opened_at IS NOT NULL)::int AS opened,
                       COUNT(*) FILTER (WHERE t.clicked_at IS NOT NULL)::int AS clicked,
                       COUNT(*) FILTER (WHERE t.status = 'failed' AND t.sent_at IS NULL)::int AS failed
                FROM newsletter_tracking t LEFT JOIN newsletter_sends s ON s.id = t.send_id`),
    hasLogs ? pool.query(`SELECT COUNT(sent_at)::int AS sent, COUNT(delivered_at)::int AS delivered, COUNT(opened_at)::int AS opened, COUNT(clicked_at)::int AS clicked,
                                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced
                          FROM email_logs`) : Promise.resolve({ rows: [{}] }),
    hasScheduled ? pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'scheduled')::int AS upcoming, COUNT(*)::int AS total FROM scheduled_emails`) : Promise.resolve({ rows: [{ upcoming: 0, total: 0 }] }),
    hasTemplates ? pool.query(`SELECT COUNT(*)::int AS total FROM newsletter_templates`) : Promise.resolve({ rows: [{ total: 0 }] }),
    pool.query(`SELECT COUNT(DISTINCT LOWER(TRIM(email)))::int AS total FROM (SELECT email FROM users WHERE email IS NOT NULL AND TRIM(email) <> '' UNION SELECT email FROM newsletter_contacts) c`).catch(() => ({ rows: [{ total: 0 }] }))
  ]);
  const c = campaignEmails.rows[0];
  const l = logEmails.rows[0];
  const sent = (c.sent || 0) + (l.sent || 0);
  const opened = (c.opened || 0) + (l.opened || 0);
  const clicked = (c.clicked || 0) + (l.clicked || 0);

  // Daily series across campaign sends and automated/scheduled emails.
  const series = (await pool.query(
    `WITH days AS (SELECT generate_series((CURRENT_DATE - ($1::int - 1)), CURRENT_DATE, '1 day')::date AS day),
     events AS (
       SELECT t.sent_at::date AS sent_day, t.opened_at::date AS open_day, t.clicked_at::date AS click_day,
              CASE WHEN t.status = 'failed' AND t.sent_at IS NULL THEN COALESCE(t.last_attempt_at, s.finished_at, s.started_at)::date END AS fail_day,
              NULL::date AS deliver_day
       FROM newsletter_tracking t LEFT JOIN newsletter_sends s ON s.id = t.send_id
       WHERE COALESCE(t.sent_at, s.started_at) >= ${since}
       ${hasLogs ? `UNION ALL
       SELECT sent_at::date, opened_at::date, clicked_at::date,
              CASE WHEN status IN ('failed', 'bounced') THEN COALESCE(failed_at, bounced_at, updated_at)::date END, delivered_at::date
       FROM email_logs WHERE queued_at >= ${since}` : ''}
     )
     SELECT d.day,
            (SELECT COUNT(*) FROM events e WHERE e.sent_day = d.day)::int AS sent,
            (SELECT COUNT(*) FROM events e WHERE e.deliver_day = d.day)::int AS delivered,
            (SELECT COUNT(*) FROM events e WHERE e.open_day = d.day)::int AS opened,
            (SELECT COUNT(*) FROM events e WHERE e.click_day = d.day)::int AS clicked,
            (SELECT COUNT(*) FROM events e WHERE e.fail_day = d.day)::int AS failed
     FROM days d ORDER BY d.day`,
    [days]
  )).rows;

  const comparison = (await pool.query(
    `SELECT s.id, n.title, s.kind, s.started_at AS "startedAt", st.accepted, st.opened, st.clicked, s.recipient_count AS "recipientCount"
     FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id ${STATS_JOIN}
     WHERE s.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted')
     ORDER BY s.started_at DESC LIMIT 8`
  )).rows.reverse();

  const recentCampaigns = (await pool.query(
    `SELECT n.id, n.title, n.subject, n.status, n.updated_at AS "updatedAt", n.recipient_count AS "recipientCount",
            COALESCE(NULLIF(TRIM(cu.full_name), ''), cu.username) AS "createdByName",
            COALESCE(NULLIF(TRIM(uu.full_name), ''), uu.username) AS "updatedByName",
            (SELECT MAX(s.started_at) FROM newsletter_sends s WHERE s.newsletter_id = n.id) AS "lastSentAt",
            (SELECT COUNT(*)::int FROM newsletter_sends s WHERE s.newsletter_id = n.id AND s.kind = 'resend') AS "resendCount"
     FROM newsletters n LEFT JOIN users cu ON cu.id = n.created_by LEFT JOIN users uu ON uu.id = n.updated_by
     ORDER BY GREATEST(n.updated_at, COALESCE(n.sent_at, n.updated_at)) DESC LIMIT 8`
  )).rows;

  const activityParts = [
    `SELECT 'send' AS type, s.kind AS detail, n.title, s.started_at AS at, COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) AS actor, s.recipient_count AS count, s.status
     FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id LEFT JOIN users u ON u.id = s.initiated_by`,
    `SELECT 'draft' AS type, CASE WHEN n.created_at = n.updated_at THEN 'created' ELSE 'updated' END, n.title, n.updated_at, COALESCE(NULLIF(TRIM(u.full_name), ''), u.username), NULL::int, n.status
     FROM newsletters n LEFT JOIN users u ON u.id = COALESCE(n.updated_by, n.created_by) WHERE n.status = 'draft'`
  ];
  if (hasScheduled) activityParts.push(`SELECT 'schedule', se.status, se.name, se.created_at, COALESCE(NULLIF(TRIM(u.full_name), ''), u.username), se.recipient_count, se.status FROM scheduled_emails se LEFT JOIN users u ON u.id = se.created_by`);
  const activity = (await pool.query(`SELECT * FROM (${activityParts.join(' UNION ALL ')}) a ORDER BY at DESC NULLS LAST LIMIT 10`)).rows;

  return {
    rangeDays: days,
    counts: {
      campaigns: campaigns.rows[0].total,
      sent: campaigns.rows[0].sent,
      drafts: campaigns.rows[0].drafts,
      scheduled: scheduled.rows[0].upcoming || 0,
      templates: templates.rows[0].total,
      contacts: contacts.rows[0].total
    },
    emails: {
      sent,
      delivered: hasLogs ? l.delivered || 0 : null,
      deliveryTracked: Boolean(hasLogs && (l.delivered || 0) > 0),
      opened,
      clicked,
      failed: (c.failed || 0) + (l.failed || 0),
      bounced: hasLogs ? l.bounced || 0 : null,
      openRate: sent ? opened / sent : null,
      clickRate: sent ? clicked / sent : null
    },
    series,
    statusDistribution: [
      { status: 'draft', count: campaigns.rows[0].drafts },
      { status: 'sent', count: campaigns.rows[0].sent },
      { status: 'scheduled', count: scheduled.rows[0].upcoming || 0 }
    ],
    comparison,
    recentCampaigns,
    activity
  };
};

module.exports = { createSend, findSendByKey, updateSendProgress, finishSend, findBouncedEmails, listSends, getSend, getDashboard };
