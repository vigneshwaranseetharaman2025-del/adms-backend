const pool = require('../config/db');

const FIELDS = `s.id, s.name, s.source_type AS "sourceType", s.newsletter_id AS "newsletterId", s.template_id AS "templateId",
  s.subject, s.recipient_type AS "recipientType", s.group_id AS "groupId", s.recipient_emails AS "recipientEmails",
  s.local_datetime AS "localDatetime", s.timezone, s.scheduled_at AS "scheduledAt", s.status,
  s.recipient_count AS "recipientCount", s.sent_count AS "sentCount", s.failed_count AS "failedCount",
  s.last_error AS "lastError", s.processed_at AS "processedAt", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
  s.from_name AS "fromName", s.from_email AS "fromEmail", s.reply_to AS "replyTo"`;

const listScheduledEmails = async ({ status } = {}) => {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE s.status = $1'; }
  return (await pool.query(
    `SELECT ${FIELDS},
       COALESCE(live.queued, 0)::int AS "queuedCount", COALESCE(live.opened, 0)::int AS "openedCount", COALESCE(live.clicked, 0)::int AS "clickedCount"
     FROM scheduled_emails s
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued,
              COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
              COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
       FROM email_logs WHERE scheduled_email_id = s.id
     ) live ON TRUE
     ${where}
     ORDER BY CASE WHEN s.status IN ('scheduled', 'processing') THEN 0 ELSE 1 END, s.scheduled_at DESC, s.id DESC`, params
  )).rows;
};

/** Sender details of one scheduled email (used when its queued emails are sent). */
const findScheduledSender = async (id) => (await pool.query(
  `SELECT from_name AS "fromName", from_email AS "fromEmail", reply_to AS "replyTo" FROM scheduled_emails WHERE id = $1`, [id]
)).rows[0] || null;

const findScheduledEmailById = async (id) => (await pool.query(`SELECT ${FIELDS} FROM scheduled_emails s WHERE s.id = $1`, [id])).rows[0] || null;

/** local_datetime + timezone are converted to an absolute instant by PostgreSQL. */
const createScheduledEmail = async (v) => (await pool.query(
  `INSERT INTO scheduled_emails (name, source_type, newsletter_id, template_id, subject, recipient_type, group_id, recipient_emails,
     local_datetime, timezone, scheduled_at, created_by, from_name, from_email, reply_to)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::varchar, $10::varchar, ($9::varchar::timestamp AT TIME ZONE $10::varchar), $11, $12, $13, $14)
   RETURNING id`,
  [v.name, v.sourceType, v.newsletterId, v.templateId, v.subject, v.recipientType, v.groupId, JSON.stringify(v.recipientEmails), v.localDatetime, v.timezone, v.userId,
    v.fromName || null, v.fromEmail || null, v.replyTo || null]
)).rows[0];

const updateScheduledEmail = async (id, v) => (await pool.query(
  `UPDATE scheduled_emails SET name = $2, source_type = $3, newsletter_id = $4, template_id = $5, subject = $6, recipient_type = $7,
     group_id = $8, recipient_emails = $9::jsonb, local_datetime = $10::varchar, timezone = $11::varchar,
     scheduled_at = ($10::varchar::timestamp AT TIME ZONE $11::varchar), from_name = $12, from_email = $13, reply_to = $14, updated_at = NOW()
   WHERE id = $1 AND status = 'scheduled' RETURNING id`,
  [id, v.name, v.sourceType, v.newsletterId, v.templateId, v.subject, v.recipientType, v.groupId, JSON.stringify(v.recipientEmails), v.localDatetime, v.timezone,
    v.fromName || null, v.fromEmail || null, v.replyTo || null]
)).rows[0] || null;

const cancelScheduledEmail = async (id) => (await pool.query(
  `UPDATE scheduled_emails SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'scheduled' RETURNING id`, [id]
)).rows[0] || null;

const deleteScheduledEmail = async (id) => (await pool.query(
  `DELETE FROM scheduled_emails WHERE id = $1 AND status IN ('cancelled', 'sent', 'failed') RETURNING id`, [id]
)).rows[0] || null;

/** Recomputes the aggregate status once none of its emails are still queued. */
const refreshScheduledEmailStatus = async (ids) => {
  if (!ids.length) return;
  await pool.query(
    `UPDATE scheduled_emails s SET
       sent_count = c.sent, failed_count = c.failed,
       status = CASE WHEN c.queued > 0 THEN 'processing' WHEN c.sent = 0 AND c.failed > 0 THEN 'failed' ELSE 'sent' END,
       updated_at = NOW()
     FROM (
       SELECT scheduled_email_id AS id,
              COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
              COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'opened', 'clicked'))::int AS sent,
              COUNT(*) FILTER (WHERE status IN ('failed', 'bounced'))::int AS failed
       FROM email_logs WHERE scheduled_email_id = ANY($1::int[]) GROUP BY scheduled_email_id
     ) c
     WHERE s.id = c.id AND s.status IN ('processing', 'sent', 'failed')`, [ids]
  );
};

module.exports = {
  listScheduledEmails, findScheduledEmailById, findScheduledSender, createScheduledEmail, updateScheduledEmail, cancelScheduledEmail,
  deleteScheduledEmail, refreshScheduledEmailStatus,
};
