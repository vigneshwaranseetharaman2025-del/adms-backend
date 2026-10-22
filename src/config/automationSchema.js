const pool = require('./db');

/**
 * Email automation schema. Safe to run on every boot (IF NOT EXISTS everywhere).
 *
 * No foreign keys point at the newsletter tables on purpose: those tables are
 * managed outside initDb.js, so the automation schema must not depend on their
 * creation order. References to newsletters/templates/groups are plain ints and
 * are validated in code.
 */
const initAutomationSchema = async () => {
  // Email builder: the editable block design is stored next to the rendered HTML.
  // Guarded because the newsletter tables are not created by initDb.js.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('public.newsletters') IS NOT NULL THEN
        ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS design_json JSONB;
      END IF;
      IF to_regclass('public.newsletter_templates') IS NOT NULL THEN
        ALTER TABLE newsletter_templates ADD COLUMN IF NOT EXISTS design_json JSONB;
      END IF;
    END $$;
  `);

  // "User Activated" trigger: a user is activated the first time they sign in.
  const hasActivatedAt = (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'activated_at'`
  )).rows.length > 0;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;`);
  if (!hasActivatedAt) {
    // One-time backfill when the column is first added: people who already used the
    // system count as activated, so deploying this does not fire "User Activated"
    // for every existing account on their next sign-in.
    await pool.query(`
      UPDATE users SET activated_at = COALESCE(last_seen, refresh_token_expires - INTERVAL '7 days', created_at, NOW())
      WHERE activated_at IS NULL AND (last_seen IS NOT NULL OR refresh_token IS NOT NULL OR is_admin = TRUE)
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused')),
      trigger_type VARCHAR(40) NOT NULL
        CHECK (trigger_type IN ('user_registered', 'user_activated', 'email_opened', 'email_clicked', 'scheduled')),
      trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      workflow JSONB NOT NULL DEFAULT '{"steps": []}'::jsonb,
      allow_reentry BOOLEAN NOT NULL DEFAULT FALSE,
      next_run_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(trigger_type, status);`);

  // One row per contact going through an automation. This IS the persisted
  // execution state: current step, when to resume, lock, attempts, errors.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_enrollments (
      id SERIAL PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      email VARCHAR(320) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      dedupe_key VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'waiting', 'completed', 'failed', 'exited')),
      current_step_id VARCHAR(64),
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      locked_until TIMESTAMPTZ,
      locked_by VARCHAR(100),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (automation_id, dedupe_key)
    );
  `);
  // A contact can only be in-flight once per automation, even under concurrent triggers.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_inflight
    ON automation_enrollments(automation_id, email)
    WHERE status IN ('active', 'waiting');
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_enrollments_due
    ON automation_enrollments(next_run_at)
    WHERE status IN ('active', 'waiting');
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_enrollments_automation ON automation_enrollments(automation_id, started_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_step_runs (
      id SERIAL PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      enrollment_id INTEGER NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
      step_id VARCHAR(64),
      step_type VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL CHECK (status IN ('completed', 'waiting', 'failed', 'skipped')),
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_step_runs_automation ON automation_step_runs(automation_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_step_runs_enrollment ON automation_step_runs(enrollment_id, created_at ASC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('newsletter', 'template')),
      newsletter_id INTEGER,
      template_id INTEGER,
      subject VARCHAR(255) NOT NULL,
      recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('all', 'group', 'contacts')),
      group_id INTEGER,
      recipient_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      local_datetime VARCHAR(19) NOT NULL,
      timezone VARCHAR(64) NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'sent', 'failed', 'cancelled')),
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      processed_at TIMESTAMPTZ,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_emails_due ON scheduled_emails(scheduled_at) WHERE status = 'scheduled';`);

  // Every automation/scheduled email goes through this table: it is both the
  // outbound queue (status = queued, next_attempt_at) and the delivery log.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY,
      source VARCHAR(20) NOT NULL CHECK (source IN ('automation', 'scheduled')),
      automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
      enrollment_id INTEGER REFERENCES automation_enrollments(id) ON DELETE SET NULL,
      step_id VARCHAR(64),
      scheduled_email_id INTEGER REFERENCES scheduled_emails(id) ON DELETE SET NULL,
      idempotency_key VARCHAR(255) NOT NULL UNIQUE,
      recipient_email VARCHAR(320) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      html_content TEXT NOT NULL,
      tracking_token UUID NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ,
      last_error TEXT,
      message_id VARCHAR(500),
      open_count INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      clicked_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      bounced_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_queue ON email_logs(next_attempt_at) WHERE status = 'queued';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_automation ON email_logs(automation_id, step_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_enrollment ON email_logs(enrollment_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_scheduled ON email_logs(scheduled_email_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_queued_at ON email_logs(queued_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_message_id ON email_logs(message_id);`);
};

module.exports = initAutomationSchema;
