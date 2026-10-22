const pool = require('./db');

const tableExists = async (client, name) => Boolean((await client.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t);

/**
 * Campaign sharing, sender details and send history. Idempotent: safe to run on every start.
 *
 *  - role_permissions.campaigns_view / campaigns_edit: role-based access to the Campaigns module
 *    (administrators always have full access). Before this, every campaign API required is_admin,
 *    so any other user who opened Campaigns got 403s and saw no drafts at all.
 *  - newsletters.updated_by / visibility / from_name / from_email / reply_to.
 *  - newsletter_sends: one row per send operation (the original send and every resend), so a
 *    resend gets its own delivery and engagement report and never overwrites the original's.
 *  - newsletter_tracking.send_id: which send a recipient row belongs to. The old unique key
 *    (newsletter_id, email) made a second send overwrite the first send's opens and clicks.
 */
const columnExists = async (client, table, column) => Boolean((await client.query(
  `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]
)).rowCount);

/**
 * Persistent sending queue (campaign worker):
 *  - newsletter_sends keeps the send's state machine, an immutable content snapshot (subject + HTML as
 *    confirmed by the user) and the pause / cancel / last-error details, so a send survives restarts.
 *  - newsletter_tracking becomes the recipient-level send record: status, attempts, SMTP code and
 *    response, next retry time, provider message id and delivery confirmation.
 *  - newsletter_events stores provider delivery events once each (deduplicated by provider event id).
 * Existing rows are converted, never dropped: a recipient with sent_at is "accepted", one without is
 * "failed" (the old sender gave up on the whole send at the first error and never recorded why).
 */
const SEND_STATUSES = ['queued', 'sending', 'paused', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed', 'interrupted'];
const RECIPIENT_STATUSES = ['pending', 'sending', 'accepted', 'failed', 'retry_scheduled', 'cancelled', 'suppressed', 'uncertain'];

const initSendQueueSchema = async (client) => {
  if (!(await tableExists(client, 'newsletter_sends'))) return;
  await client.query('BEGIN');
  const sendCols = [
    'snapshot_subject TEXT', 'snapshot_html TEXT', "content_source VARCHAR(20) NOT NULL DEFAULT 'saved'",
    'pause_reason TEXT', 'error_code VARCHAR(40)', 'paused_at TIMESTAMPTZ', 'paused_by INTEGER',
    'cancel_requested_at TIMESTAMPTZ', 'cancelled_by INTEGER', 'tracking_origin TEXT', 'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'
  ];
  for (const col of sendCols) await client.query(`ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS ${col};`);
  // "completed_with_errors" does not fit the original VARCHAR(20).
  await client.query(`ALTER TABLE newsletter_sends ALTER COLUMN status TYPE VARCHAR(30)`);
  const { rows: checks } = await client.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'newsletter_sends'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'`);
  for (const { conname } of checks.filter((c) => c.conname !== 'chk_newsletter_sends_status')) {
    await client.query(`ALTER TABLE newsletter_sends DROP CONSTRAINT "${conname.replace(/"/g, '""')}"`);
  }
  if (!checks.some((c) => c.conname === 'chk_newsletter_sends_status')) {
    await client.query(`ALTER TABLE newsletter_sends ADD CONSTRAINT chk_newsletter_sends_status CHECK (status IN (${SEND_STATUSES.map((v) => `'${v}'`).join(', ')}))`);
  }
  // Sends started by the old in-memory sender (no snapshot) cannot be resumed after a restart.
  await client.query(`UPDATE newsletter_sends SET status = 'interrupted', finished_at = COALESCE(finished_at, NOW()) WHERE status = 'sending' AND snapshot_html IS NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_sends_active ON newsletter_sends(status) WHERE status IN ('queued', 'sending', 'paused', 'cancelling')`);

  if (await tableExists(client, 'newsletter_tracking')) {
    const converting = !(await columnExists(client, 'newsletter_tracking', 'status'));
    const trackCols = [
      "status VARCHAR(20) NOT NULL DEFAULT 'pending'", 'recipient_name TEXT', 'attempt_count INTEGER NOT NULL DEFAULT 0',
      'last_attempt_at TIMESTAMPTZ', 'next_retry_at TIMESTAMPTZ', 'claimed_at TIMESTAMPTZ', 'smtp_code INTEGER',
      'error_class VARCHAR(24)', 'last_error TEXT', 'provider_response TEXT', 'message_id TEXT',
      'delivered_at TIMESTAMPTZ', 'bounced_at TIMESTAMPTZ', 'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'
    ];
    for (const col of trackCols) await client.query(`ALTER TABLE newsletter_tracking ADD COLUMN IF NOT EXISTS ${col};`);
    if (converting) {
      await client.query(`UPDATE newsletter_tracking SET status = 'accepted', attempt_count = 1, last_attempt_at = sent_at WHERE sent_at IS NOT NULL`);
      await client.query(`
        UPDATE newsletter_tracking SET status = 'failed', attempt_count = 1, error_class = 'unknown',
               last_error = 'No acceptance was recorded for this recipient. It was sent by the earlier sender, which stopped recording at the first error.'
        WHERE sent_at IS NULL`);
      // Recount old sends from their recipient rows; a send that stopped at one bad address but got
      // other emails accepted is "completed with errors", not "failed".
      await client.query(`
        UPDATE newsletter_sends s SET sent_count = c.accepted, failed_count = c.failed,
               status = CASE WHEN s.status = 'failed' AND c.accepted > 0 THEN 'completed_with_errors' ELSE s.status END
        FROM (SELECT send_id, COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
              FROM newsletter_tracking WHERE send_id IS NOT NULL GROUP BY send_id) c
        WHERE c.send_id = s.id`);
    }
    const { rows: tchecks } = await client.query(`
      SELECT conname FROM pg_constraint WHERE conrelid = 'newsletter_tracking'::regclass AND contype = 'c' AND conname = 'chk_newsletter_tracking_status'`);
    if (!tchecks.length) {
      await client.query(`ALTER TABLE newsletter_tracking ADD CONSTRAINT chk_newsletter_tracking_status CHECK (status IN (${RECIPIENT_STATUSES.map((v) => `'${v}'`).join(', ')}))`);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_tracking_send_status ON newsletter_tracking(send_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_tracking_due ON newsletter_tracking(send_id, next_retry_at) WHERE status = 'retry_scheduled'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_tracking_message ON newsletter_tracking(message_id) WHERE message_id IS NOT NULL`);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS newsletter_events (
      id SERIAL PRIMARY KEY,
      provider_event_id VARCHAR(200) UNIQUE,
      tracking_id INTEGER,
      send_id INTEGER,
      event_type VARCHAR(20) NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detail TEXT
    );`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_events_send ON newsletter_events(send_id, event_type)`);

  // Scheduled emails get their own sender details (From name, From email, Reply-To), like campaigns.
  if (await tableExists(client, 'scheduled_emails')) {
    for (const col of ['from_name VARCHAR(100)', 'from_email VARCHAR(320)', 'reply_to VARCHAR(320)']) {
      await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS ${col};`);
    }
  }
  // Automated / scheduled emails used to be marked "delivered" the moment the mail server accepted them
  // (sent_at and delivered_at written by the same statement, so they are identical). Acceptance is not
  // delivery: those rows go back to "sent". Real delivery events from the provider are kept.
  if (await tableExists(client, 'email_logs')) {
    await client.query(`
      UPDATE email_logs SET delivered_at = NULL, status = CASE WHEN status = 'delivered' THEN 'sent' ELSE status END
      WHERE delivered_at IS NOT NULL AND delivered_at = sent_at`);
  }
  await client.query('COMMIT');
};

const initCampaignSchema = async () => {
  const client = await pool.connect();
  try {
    if (await tableExists(client, 'role_permissions')) {
      await client.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS campaigns_view BOOLEAN NOT NULL DEFAULT FALSE;`);
      await client.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS campaigns_edit BOOLEAN NOT NULL DEFAULT FALSE;`);
    }

    // The templates query reads a slug column that no migration created; make sure it exists.
    if (await tableExists(client, 'newsletter_templates')) {
      await client.query(`ALTER TABLE newsletter_templates ADD COLUMN IF NOT EXISTS slug VARCHAR(120);`);
    }

    if (!(await tableExists(client, 'newsletters'))) return;

    await client.query(`ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS updated_by INTEGER;`);
    await client.query(`ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'organisation';`);
    await client.query(`ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS from_name VARCHAR(100);`);
    await client.query(`ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS from_email VARCHAR(320);`);
    await client.query(`ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS reply_to VARCHAR(320);`);
    await client.query(`UPDATE newsletters SET updated_by = created_by WHERE updated_by IS NULL AND created_by IS NOT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS newsletter_sends (
        id SERIAL PRIMARY KEY,
        newsletter_id INTEGER NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'original' CHECK (kind IN ('original', 'resend')),
        audience_type VARCHAR(20) NOT NULL DEFAULT 'organisation'
          CHECK (audience_type IN ('organisation', 'group', 'contacts', 'individual', 'unknown')),
        audience_label VARCHAR(500),
        group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        subject VARCHAR(255),
        from_name VARCHAR(100),
        from_email VARCHAR(320),
        reply_to VARCHAR(320),
        recipient_count INTEGER NOT NULL DEFAULT 0,
        excluded_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'sending'
          CHECK (status IN ('sending', 'completed', 'failed', 'cancelled', 'interrupted')),
        error TEXT,
        idempotency_key VARCHAR(100) UNIQUE,
        initiated_by INTEGER,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_sends_newsletter ON newsletter_sends(newsletter_id, started_at DESC);`);

    if (await tableExists(client, 'newsletter_tracking')) {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE newsletter_tracking ADD COLUMN IF NOT EXISTS send_id INTEGER;`);
      // History from before send records existed becomes one "original" send per campaign.
      await client.query(`
        INSERT INTO newsletter_sends (newsletter_id, kind, audience_type, audience_label, subject, recipient_count, sent_count, failed_count, status, initiated_by, started_at, finished_at)
        SELECT n.id, 'original', 'unknown', 'Original send', n.subject,
               COUNT(t.*)::int, COUNT(t.sent_at)::int, (COUNT(t.*) - COUNT(t.sent_at))::int,
               CASE WHEN n.status = 'sent' THEN 'completed' ELSE 'interrupted' END,
               n.created_by, COALESCE(n.sent_at, MIN(t.sent_at), n.updated_at, NOW()), COALESCE(n.sent_at, MAX(t.sent_at), NOW())
        FROM newsletters n
        JOIN newsletter_tracking t ON t.newsletter_id = n.id AND t.send_id IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM newsletter_sends s WHERE s.newsletter_id = n.id)
        GROUP BY n.id;
      `);
      await client.query(`
        UPDATE newsletter_tracking t SET send_id = s.id
        FROM newsletter_sends s
        WHERE t.send_id IS NULL AND s.newsletter_id = t.newsletter_id AND s.kind = 'original';
      `);
      // Replace the per-campaign unique key with a per-send one, so each send keeps its own rows.
      const { rows: constraints } = await client.query(`
        SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid = 'newsletter_tracking'::regclass AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
              = ARRAY['email', 'newsletter_id']::text[]
      `);
      for (const { conname } of constraints) await client.query(`ALTER TABLE newsletter_tracking DROP CONSTRAINT "${conname.replace(/"/g, '""')}"`);
      const { rows: indexes } = await client.query(`
        SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = 'newsletter_tracking'::regclass AND x.indisunique AND NOT x.indisprimary
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(x.indkey) k JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k)
              = ARRAY['email', 'newsletter_id']::text[]
      `);
      for (const { relname } of indexes) await client.query(`DROP INDEX IF EXISTS "${relname.replace(/"/g, '""')}"`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_newsletter_tracking_send_email ON newsletter_tracking(send_id, email);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_tracking_newsletter ON newsletter_tracking(newsletter_id);`);
      await client.query('COMMIT');
    }

    await initSendQueueSchema(client);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

module.exports = initCampaignSchema;
