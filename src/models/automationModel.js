const pool = require('../config/db');

const AUTOMATION_FIELDS = `a.id, a.name, a.description, a.status, a.trigger_type AS "triggerType", a.trigger_config AS "triggerConfig",
  a.workflow, a.allow_reentry AS "allowReentry", a.next_run_at AS "nextRunAt", a.last_run_at AS "lastRunAt",
  a.activated_at AS "activatedAt", a.created_by AS "createdBy", a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

const STATS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE l.status NOT IN ('queued', 'failed'))::int AS "emailsSent",
           COUNT(*) FILTER (WHERE l.opened_at IS NOT NULL)::int AS "emailsOpened",
           COUNT(*) FILTER (WHERE l.clicked_at IS NOT NULL)::int AS "emailsClicked",
           COUNT(*) FILTER (WHERE l.status IN ('failed', 'bounced'))::int AS "emailsFailed",
           COUNT(*) FILTER (WHERE l.status = 'queued')::int AS "emailsQueued"
    FROM email_logs l WHERE l.automation_id = a.id
  ) es ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS "enrolled",
           COUNT(*) FILTER (WHERE e.status IN ('active', 'waiting'))::int AS "inProgress",
           COUNT(*) FILTER (WHERE e.status = 'completed')::int AS "completed",
           COUNT(*) FILTER (WHERE e.status = 'failed')::int AS "failed",
           MIN(e.next_run_at) FILTER (WHERE e.status IN ('active', 'waiting')) AS "nextEnrollmentRunAt"
    FROM automation_enrollments e WHERE e.automation_id = a.id
  ) en ON TRUE`;

const listAutomations = async () => (await pool.query(
  `SELECT ${AUTOMATION_FIELDS}, es.*, en.*
   FROM automations a ${STATS_JOIN}
   ORDER BY a.updated_at DESC, a.id DESC`
)).rows;

const findAutomationById = async (id, client = pool) => (await client.query(
  `SELECT ${AUTOMATION_FIELDS}, es.*, en.* FROM automations a ${STATS_JOIN} WHERE a.id = $1`, [id]
)).rows[0] || null;

const createAutomation = async ({ name, description, triggerType, triggerConfig, workflow, allowReentry, nextRunAt, userId }) => (await pool.query(
  `INSERT INTO automations (name, description, trigger_type, trigger_config, workflow, allow_reentry, next_run_at, created_by)
   VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING id`,
  [name, description, triggerType, JSON.stringify(triggerConfig), JSON.stringify(workflow), allowReentry, nextRunAt, userId]
)).rows[0];

const updateAutomation = async ({ id, name, description, triggerType, triggerConfig, workflow, allowReentry, nextRunAt }) => (await pool.query(
  `UPDATE automations SET name = $2, description = $3, trigger_type = $4, trigger_config = $5::jsonb, workflow = $6::jsonb,
     allow_reentry = $7, next_run_at = $8, updated_at = NOW()
   WHERE id = $1 RETURNING id`,
  [id, name, description, triggerType, JSON.stringify(triggerConfig), JSON.stringify(workflow), allowReentry, nextRunAt]
)).rows[0] || null;

const setAutomationStatus = async (id, status, nextRunAt) => (await pool.query(
  `UPDATE automations SET status = $2::varchar,
     activated_at = CASE WHEN $2::varchar = 'active' AND activated_at IS NULL THEN NOW() ELSE activated_at END,
     next_run_at = $3::timestamptz, updated_at = NOW()
   WHERE id = $1 RETURNING id`, [id, status, nextRunAt]
)).rows[0] || null;

/** Deleting cancels anything still queued, keeps sent logs for reporting. */
const deleteAutomation = async (id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE email_logs SET status = 'failed', failed_at = NOW(), last_error = 'Automation deleted before sending.', updated_at = NOW()
       WHERE automation_id = $1 AND status = 'queued'`, [id]
    );
    const result = await client.query('DELETE FROM automations WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const findActiveAutomationsByTrigger = async (triggerType) => (await pool.query(
  `SELECT id, name, trigger_type AS "triggerType", trigger_config AS "triggerConfig", workflow, allow_reentry AS "allowReentry"
   FROM automations WHERE status = 'active' AND trigger_type = $1`, [triggerType]
)).rows;

/**
 * Enrolls one contact. Duplicate protection:
 *  - UNIQUE(automation_id, dedupe_key): the same trigger event never enrolls twice
 *  - partial unique index: a contact is never in-flight twice in one automation
 *  - NOT EXISTS: when re-entry is off, a contact only ever goes through once
 * Returns the new enrollment or null when skipped.
 */
const enrollContact = async ({ automationId, email, userId, dedupeKey, firstStepId, allowReentry, context }) => (await pool.query(
  `INSERT INTO automation_enrollments (automation_id, email, user_id, dedupe_key, current_step_id, status, next_run_at, context, completed_at)
   SELECT $1::int, $2::varchar, $3::int, $4::varchar, $5::varchar, CASE WHEN $5::varchar IS NULL THEN 'completed' ELSE 'active' END, NOW(), $7::jsonb,
          CASE WHEN $5::varchar IS NULL THEN NOW() END
   WHERE $6::boolean OR NOT EXISTS (
     SELECT 1 FROM automation_enrollments WHERE automation_id = $1::int AND email = $2::varchar
   )
   ON CONFLICT DO NOTHING
   RETURNING id, automation_id AS "automationId", email, status`,
  [automationId, email, userId || null, dedupeKey, firstStepId, Boolean(allowReentry), JSON.stringify(context || {})]
)).rows[0] || null;

/** Claims due enrollments for this worker. SKIP LOCKED makes it safe with several server instances. */
const claimDueEnrollments = async (workerId, limit = 50, lockSeconds = 300) => (await pool.query(
  `UPDATE automation_enrollments e
   SET locked_until = NOW() + make_interval(secs => $3), locked_by = $1, updated_at = NOW()
   WHERE e.id IN (
     SELECT e2.id FROM automation_enrollments e2
     JOIN automations a ON a.id = e2.automation_id
     WHERE e2.status IN ('active', 'waiting') AND a.status = 'active'
       AND e2.next_run_at <= NOW()
       AND (e2.locked_until IS NULL OR e2.locked_until < NOW())
     ORDER BY e2.next_run_at
     LIMIT $2
     FOR UPDATE OF e2 SKIP LOCKED
   )
   RETURNING e.id, e.automation_id AS "automationId", e.email, e.user_id AS "userId", e.status,
     e.current_step_id AS "currentStepId", e.attempts, e.context`,
  [workerId, limit, lockSeconds]
)).rows;

/** Saves state and releases the lock, but only if this worker still owns it. */
const saveEnrollmentState = async ({ id, workerId, status, currentStepId, nextRunAt, attempts, lastError }) => (await pool.query(
  `UPDATE automation_enrollments
   SET status = $3::varchar, current_step_id = $4::varchar, next_run_at = COALESCE($5::timestamptz, next_run_at), attempts = $6, last_error = $7,
       completed_at = CASE WHEN $3::varchar IN ('completed', 'failed', 'exited') THEN NOW() ELSE NULL END,
       locked_until = NULL, locked_by = NULL, updated_at = NOW()
   WHERE id = $1 AND locked_by = $2 RETURNING id`,
  [id, workerId, status, currentStepId, nextRunAt, attempts, lastError]
)).rows[0] || null;

const touchAutomationsRun = async (ids) => {
  if (!ids.length) return;
  await pool.query(`UPDATE automations SET last_run_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
};

const recordStepRun = async ({ automationId, enrollmentId, stepId, stepType, status, message }) => pool.query(
  `INSERT INTO automation_step_runs (automation_id, enrollment_id, step_id, step_type, status, message)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [automationId, enrollmentId, stepId, stepType, status, message ? String(message).slice(0, 2000) : null]
);

const listEnrollments = async (automationId, { page = 1, pageSize = 20, status } = {}) => {
  const params = [automationId];
  let where = 'e.automation_id = $1';
  if (status) { params.push(status); where += ` AND e.status = $${params.length}`; }
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM automation_enrollments e WHERE ${where}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const rows = (await pool.query(
    `SELECT e.id, e.email, e.status, e.current_step_id AS "currentStepId", e.next_run_at AS "nextRunAt",
            e.attempts, e.last_error AS "lastError", e.started_at AS "startedAt", e.completed_at AS "completedAt",
            e.context, COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, e.context->>'name') AS name,
            (SELECT COUNT(*)::int FROM email_logs l WHERE l.enrollment_id = e.id AND l.status NOT IN ('queued', 'failed')) AS "emailsSent"
     FROM automation_enrollments e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ${where}
     ORDER BY e.started_at DESC, e.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  )).rows;
  return { items: rows, total: countResult.rows[0].total, page, pageSize };
};

const listEnrollmentSteps = async (automationId, enrollmentId) => (await pool.query(
  `SELECT id, step_id AS "stepId", step_type AS "stepType", status, message, created_at AS "createdAt"
   FROM automation_step_runs WHERE automation_id = $1 AND enrollment_id = $2 ORDER BY created_at ASC, id ASC`,
  [automationId, enrollmentId]
)).rows;

const listStepEmailStats = async (automationId) => (await pool.query(
  `SELECT step_id AS "stepId",
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
          COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
          COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
          COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced
   FROM email_logs WHERE automation_id = $1 GROUP BY step_id`, [automationId]
)).rows;

const listStepReach = async (automationId) => (await pool.query(
  `SELECT step_id AS "stepId", COUNT(DISTINCT enrollment_id)::int AS reached
   FROM automation_step_runs WHERE automation_id = $1 GROUP BY step_id`, [automationId]
)).rows;

const listAutomationErrors = async (automationId, limit = 100) => (await pool.query(
  `SELECT * FROM (
     SELECT 'step' AS kind, r.id, r.step_id AS "stepId", r.step_type AS "stepType", e.email, r.message AS error, r.created_at AS "occurredAt", NULL::int AS "emailLogId"
     FROM automation_step_runs r JOIN automation_enrollments e ON e.id = r.enrollment_id
     WHERE r.automation_id = $1 AND r.status = 'failed'
     UNION ALL
     SELECT 'email' AS kind, l.id, l.step_id, 'send_email', l.recipient_email, COALESCE(l.last_error, l.status), COALESCE(l.bounced_at, l.failed_at, l.updated_at), l.id
     FROM email_logs l WHERE l.automation_id = $1 AND (l.status IN ('failed', 'bounced') OR (l.status = 'queued' AND l.last_error IS NOT NULL))
   ) errors ORDER BY "occurredAt" DESC LIMIT $2`, [automationId, limit]
)).rows;

const getDashboardSummary = async () => (await pool.query(
  `SELECT
     (SELECT COUNT(*)::int FROM automations) AS "totalAutomations",
     (SELECT COUNT(*)::int FROM automations WHERE status = 'active') AS "activeAutomations",
     (SELECT COUNT(*)::int FROM automation_enrollments WHERE status IN ('active', 'waiting')) AS "contactsInProgress",
     (SELECT COUNT(*)::int FROM email_logs WHERE source = 'automation' AND status NOT IN ('queued', 'failed')) AS "emailsSent",
     (SELECT COUNT(*)::int FROM email_logs WHERE source = 'automation' AND opened_at IS NOT NULL) AS "emailsOpened",
     (SELECT COUNT(*)::int FROM email_logs WHERE source = 'automation' AND clicked_at IS NOT NULL) AS "emailsClicked",
     (SELECT COUNT(*)::int FROM scheduled_emails WHERE status = 'scheduled') AS "scheduledPending"`
)).rows[0];

module.exports = {
  listAutomations, findAutomationById, createAutomation, updateAutomation, setAutomationStatus, deleteAutomation,
  findActiveAutomationsByTrigger, enrollContact, claimDueEnrollments, saveEnrollmentState, touchAutomationsRun,
  recordStepRun, listEnrollments, listEnrollmentSteps, listStepEmailStats, listStepReach, listAutomationErrors,
  getDashboardSummary,
};
