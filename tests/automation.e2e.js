/* eslint-disable no-console */
/**
 * End-to-end test for email automation.
 *
 * Needs: the API running (npm start), PostgreSQL, and an SMTP server.
 * For local runs use the bundled mock SMTP (tests/smtp-mock.js) with SMTP_HOST=127.0.0.1 SMTP_PORT=2525.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 API_URL=https://localhost:5000 node tests/automation.e2e.js
 *
 * Waits are fast-forwarded by moving next_run_at in the database, so the
 * 1-day / 3-day onboarding workflow is verified in seconds.
 */
require('dotenv').config();
const pool = require('../src/config/db');

const API = (process.env.API_URL || `https://localhost:${process.env.PORT || 5000}`) + '/api';
const ADMIN_USER = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
const RUN = Date.now().toString(36);

let token;
let passed = 0;
const failures = [];

const call = async (method, path, body, { auth = true, raw = false } = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return response;
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
};

const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${detail}`); }
};

const runEngine = () => call('POST', '/automations/engine/run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const fastForward = (automationId) => q(
  `UPDATE automation_enrollments SET next_run_at = NOW() - INTERVAL '1 second' WHERE automation_id = $1 AND status IN ('active','waiting')`, [automationId]
);
const logsFor = (automationId) => q(`SELECT * FROM email_logs WHERE automation_id = $1 ORDER BY id`, [automationId]);

const register = (username, fullName, email, extra = {}) => call('POST', '/auth/register', {
  username, password: 'Passw0rd!', full_name: fullName, email, ...extra,
});

(async () => {
  console.log(`Running against ${API}\n`);
  const login = await call('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS }, { auth: false });
  token = login.data?.accessToken;
  if (!token) { console.error('Admin login failed', login); process.exit(1); }
  // Isolate this run from automations left active by earlier runs.
  await q(`UPDATE automations SET status = 'paused' WHERE status = 'active' AND name ~ ' [a-z0-9]{6,}$'`);

  /* ---------------------------------------------------------------- */
  console.log('1. Onboarding example: Registered → Welcome → 1d → Getting started → 3d → Follow-up → End');
  const meta = await call('GET', '/automations/meta');
  check('meta returns merge tags', meta.data.mergeTags.includes('registeredAt'));
  const created = await call('POST', '/automations', {
    name: `Onboarding ${RUN}`, triggerType: 'user_registered', workflow: meta.data.example.workflow,
  });
  check('create automation (draft)', created.status === 201 && created.data.status === 'draft', JSON.stringify(created.data));
  const onboarding = created.data;
  check('dashboard reports 6 steps', onboarding.stepCount === 6);

  await register(`early_${RUN}`, 'Early Bird', `early_${RUN}@test.com`);
  await runEngine();
  check('draft automation does not enroll', (await q('SELECT 1 FROM automation_enrollments WHERE automation_id = $1', [onboarding.id])).length === 0);

  const activated = await call('POST', `/automations/${onboarding.id}/activate`);
  check('activate', activated.data.status === 'active');

  const alice = `alice_${RUN}@test.com`;
  const reg = await register(`alice_${RUN}`, 'Alice Wonder', alice);
  check('register user', reg.status === 201);
  await sleep(300);
  await runEngine();
  let logs = await logsFor(onboarding.id);
  check('welcome email sent right away', logs.length === 1 && ['delivered', 'sent'].includes(logs[0].status), JSON.stringify(logs.map((l) => l.status)));
  check('subject personalised', logs[0]?.subject === 'Welcome aboard, Alice!', logs[0]?.subject);
  check('body personalised (name + email)', logs[0]?.html_content.includes('Welcome, Alice Wonder') && logs[0]?.html_content.includes(alice));
  check('tracking pixel added', logs[0]?.html_content.includes('/api/automations/track/'));
  let [enrollment] = await q('SELECT * FROM automation_enrollments WHERE automation_id = $1', [onboarding.id]);
  check('enrollment waiting ~1 day', enrollment.status === 'waiting' && (new Date(enrollment.next_run_at) - Date.now()) > 23 * 3600 * 1000);

  await runEngine();
  check('no early send before wait ends', (await logsFor(onboarding.id)).length === 1);

  await fastForward(onboarding.id);
  await runEngine();
  logs = await logsFor(onboarding.id);
  check('getting-started email after day 1', logs.length === 2 && logs[1].subject === 'Alice, here is how to get started');
  [enrollment] = await q('SELECT * FROM automation_enrollments WHERE automation_id = $1', [onboarding.id]);
  check('then waits ~3 days', (new Date(enrollment.next_run_at) - Date.now()) > 71 * 3600 * 1000);

  await fastForward(onboarding.id);
  await runEngine();
  logs = await logsFor(onboarding.id);
  [enrollment] = await q('SELECT * FROM automation_enrollments WHERE automation_id = $1', [onboarding.id]);
  check('follow-up email after day 3', logs.length === 3 && logs[2].subject === 'How is it going, Alice?');
  check('enrollment completed at End', enrollment.status === 'completed');

  const history = await call('GET', `/automations/${onboarding.id}/enrollments/${enrollment.id}/steps`);
  check('execution history recorded', history.data.length >= 8, `${history.data.length} rows`);

  /* ---------------------------------------------------------------- */
  console.log('\n2. Duplicate execution protection');
  const { emitAutomationEvent } = require('../src/services/automation/triggers');
  const userRow = (await q('SELECT id FROM users WHERE email = $1', [alice]))[0];
  await emitAutomationEvent('user_registered', { email: alice, userId: userRow.id, eventKey: `user:${userRow.id}` });
  await emitAutomationEvent('user_registered', { email: alice, userId: userRow.id, eventKey: `user:${userRow.id}` });
  check('same event does not re-enroll', (await q('SELECT 1 FROM automation_enrollments WHERE automation_id = $1', [onboarding.id])).length === 1);

  const bob = `bob_${RUN}@test.com`;
  await register(`bob_${RUN}`, 'Bob Builder', bob);
  await sleep(100);
  await Promise.all([runEngine(), runEngine(), runEngine()]);
  const bobLogs = await q('SELECT * FROM email_logs WHERE automation_id = $1 AND recipient_email = $2', [onboarding.id, bob]);
  check('parallel engine runs send exactly one email', bobLogs.length === 1, `${bobLogs.length}`);

  /* ---------------------------------------------------------------- */
  console.log('\n3. Pause / resume');
  await call('POST', `/automations/${onboarding.id}/pause`);
  await fastForward(onboarding.id);
  await runEngine();
  check('paused automation does not advance', (await q('SELECT 1 FROM email_logs WHERE automation_id = $1 AND recipient_email = $2', [onboarding.id, bob])).length === 1);
  const resumed = await call('POST', `/automations/${onboarding.id}/resume`);
  check('resume', resumed.data.status === 'active');
  await runEngine();
  check('resumed automation continues', (await q('SELECT 1 FROM email_logs WHERE automation_id = $1 AND recipient_email = $2', [onboarding.id, bob])).length === 2);

  /* ---------------------------------------------------------------- */
  console.log('\n4. Retry and bounce');
  const flaky = `flaky_${RUN}@test.com`;
  const bounce = `bounce_${RUN}@test.com`;
  await register(`flaky_${RUN}`, 'Flaky Inbox', flaky);
  await register(`bounce_${RUN}`, 'Bounce Inbox', bounce);
  await sleep(100);
  await runEngine();
  let [flakyLog] = await q('SELECT * FROM email_logs WHERE recipient_email = $1', [flaky]);
  check('temporary failure is re-queued with backoff', flakyLog.status === 'queued' && flakyLog.attempts === 1 && flakyLog.last_error && new Date(flakyLog.next_attempt_at) > new Date());
  await q(`UPDATE email_logs SET next_attempt_at = NOW() WHERE id = $1`, [flakyLog.id]);
  await runEngine();
  await q(`UPDATE email_logs SET next_attempt_at = NOW() WHERE id = $1`, [flakyLog.id]);
  await runEngine();
  [flakyLog] = await q('SELECT * FROM email_logs WHERE id = $1', [flakyLog.id]);
  check('succeeds on 3rd attempt', ['delivered', 'sent'].includes(flakyLog.status) && flakyLog.attempts === 3, `${flakyLog.status}/${flakyLog.attempts}`);
  const [bounceLog] = await q('SELECT * FROM email_logs WHERE recipient_email = $1', [bounce]);
  check('5xx rejection is marked bounced (no retry)', bounceLog.status === 'bounced' && bounceLog.attempts === 1, bounceLog.status);

  /* ---------------------------------------------------------------- */
  console.log('\n5. Condition: User Activated → email → wait → opened? yes/no');
  const condAuto = await call('POST', '/automations', {
    name: `Activation ${RUN}`, triggerType: 'user_activated',
    workflow: {
      steps: [
        { id: 'first', type: 'send_email', config: { sourceType: 'custom', subject: 'Hi {{firstName|there}}', htmlContent: '<p>Hi {{firstName}}, <a href="https://example.com/start">start here</a></p>' } },
        { id: 'w1', type: 'wait', config: { amount: 2, unit: 'hours' } },
        {
          id: 'c1', type: 'condition', config: { check: 'email_opened', stepId: 'previous' },
          branches: {
            yes: [{ id: 'yes1', type: 'send_email', config: { sourceType: 'custom', subject: 'Thanks for reading', htmlContent: '<p>Thanks</p>' } }],
            no: [{ id: 'no1', type: 'send_email', config: { sourceType: 'custom', subject: 'Reminder', htmlContent: '<p>Reminder</p>' } }, { id: 'noend', type: 'end' }],
          },
        },
        { id: 'after', type: 'send_email', config: { sourceType: 'custom', subject: 'Merged step', htmlContent: '<p>Merged</p>' } },
      ],
    },
  });
  check('create condition workflow', condAuto.status === 201, JSON.stringify(condAuto.data));
  await call('POST', `/automations/${condAuto.data.id}/activate`);
  const carol = `carol_${RUN}@test.com`;
  const dave = `dave_${RUN}@test.com`;
  await register(`carol_${RUN}`, 'Carol Opener', carol);
  await register(`dave_${RUN}`, 'Dave Ignorer', dave);
  for (const u of [`carol_${RUN}`, `dave_${RUN}`]) await call('POST', '/auth/login', { username: u, password: 'Passw0rd!' }, { auth: false });
  await call('POST', '/auth/login', { username: `carol_${RUN}`, password: 'Passw0rd!' }, { auth: false }); // second login: no new activation
  await sleep(300);
  await runEngine();
  const firstLogs = await logsFor(condAuto.data.id);
  check('activation trigger fired once per user', firstLogs.length === 2, `${firstLogs.length}`);
  const carolLog = firstLogs.find((l) => l.recipient_email === carol);
  const pixel = await call('GET', `/automations/track/${carolLog.tracking_token}`, null, { auth: false, raw: true });
  check('tracking pixel returns gif', pixel.headers.get('content-type') === 'image/gif');
  const click = await call('GET', `/automations/click/${carolLog.tracking_token}?u=${encodeURIComponent('https://example.com/start')}`, null, { auth: false, raw: true });
  check('click redirects to original link', click.status === 302 && click.headers.get('location') === 'https://example.com/start');
  const [carolTracked] = await q('SELECT status, opened_at, clicked_at FROM email_logs WHERE id = $1', [carolLog.id]);
  check('log status → clicked', carolTracked.status === 'clicked' && carolTracked.opened_at);
  await fastForward(condAuto.data.id);
  await runEngine();
  const carolSubjects = (await q('SELECT subject FROM email_logs WHERE recipient_email = $1 AND automation_id = $2 ORDER BY id', [carol, condAuto.data.id])).map((r) => r.subject);
  const daveSubjects = (await q('SELECT subject FROM email_logs WHERE recipient_email = $1 AND automation_id = $2 ORDER BY id', [dave, condAuto.data.id])).map((r) => r.subject);
  check('opener takes Yes branch then merges', JSON.stringify(carolSubjects) === JSON.stringify(['Hi Carol', 'Thanks for reading', 'Merged step']), JSON.stringify(carolSubjects));
  check('non-opener takes No branch and ends', JSON.stringify(daveSubjects) === JSON.stringify(['Hi Dave', 'Reminder']), JSON.stringify(daveSubjects));

  /* ---------------------------------------------------------------- */
  console.log('\n6. Email Opened trigger from an existing campaign');
  const [newsletter] = await q(`INSERT INTO newsletters (title, subject, html_content, status) VALUES ($1, 'Monthly', '<p>Hello {{firstName}}</p>', 'sent') RETURNING id`, [`Campaign ${RUN}`]);
  const openAuto = await call('POST', '/automations', {
    name: `Opened ${RUN}`, triggerType: 'email_opened', triggerConfig: { newsletterId: newsletter.id },
    workflow: { steps: [{ type: 'send_email', config: { sourceType: 'newsletter', newsletterId: newsletter.id, subject: 'Because you opened, {{firstName}}' } }] },
  });
  await call('POST', `/automations/${openAuto.data.id}/activate`);
  const campaignToken = require('crypto').randomUUID();
  await q(`INSERT INTO newsletter_tracking (newsletter_id, email, tracking_token, sent_at) VALUES ($1, $2, $3, NOW())`, [newsletter.id, alice, campaignToken]);
  await call('GET', `/newsletters/track/${campaignToken}`, null, { auth: false, raw: true });
  await call('GET', `/newsletters/track/${campaignToken}`, null, { auth: false, raw: true });
  await sleep(300);
  await runEngine();
  const openLogs = await logsFor(openAuto.data.id);
  check('campaign open enrolls once (opened twice)', openLogs.length === 1 && openLogs[0].subject === 'Because you opened, Alice', JSON.stringify(openLogs.map((l) => l.subject)));
  check('campaign content personalised', openLogs[0]?.html_content.includes('Hello Alice'));

  /* ---------------------------------------------------------------- */
  console.log('\n7. Scheduled emails');
  const [template] = await q(`INSERT INTO newsletter_templates (name, html_content) VALUES ($1, '<p>Dear {{firstName}} {{lastName}}, joined {{registeredAt}}</p>') RETURNING id`, [`Tpl ${RUN}`]);
  const [{ group_id: groupId }] = await q(`INSERT INTO newsletter_groups (name, color, member_emails) VALUES ($1, '#1976d2', $2::jsonb) RETURNING id AS group_id`, [`Group ${RUN}`, JSON.stringify([alice, bob])]);
  const past = await call('POST', '/automations/scheduled-emails', {
    name: 'Past', sourceType: 'template', templateId: template.id, subject: 'x', recipientType: 'group', groupId, localDatetime: '2020-01-01T10:00', timezone: 'Asia/Kolkata',
  });
  check('rejects a time in the past', past.status === 400);
  const badTz = await call('POST', '/automations/scheduled-emails', {
    name: 'Bad', sourceType: 'template', templateId: template.id, subject: 'x', recipientType: 'group', groupId, localDatetime: '2099-01-01T10:00', timezone: 'Mars/Base',
  });
  check('rejects an unknown timezone', badTz.status === 400);
  const scheduled = await call('POST', '/automations/scheduled-emails', {
    name: `Digest ${RUN}`, sourceType: 'template', templateId: template.id, subject: 'Digest for {{firstName}}', recipientType: 'group', groupId, localDatetime: '2099-06-01T09:30', timezone: 'Asia/Kolkata',
  });
  check('schedule email', scheduled.status === 201 && scheduled.data.status === 'scheduled');
  check('timezone converted to UTC (09:30 IST = 04:00Z)', new Date(scheduled.data.scheduledAt).toISOString() === '2099-06-01T04:00:00.000Z', scheduled.data.scheduledAt);
  const edited = await call('PUT', `/automations/scheduled-emails/${scheduled.data.id}`, {
    name: `Digest ${RUN}`, sourceType: 'template', templateId: template.id, subject: 'Digest for {{firstName}}', recipientType: 'group', groupId, localDatetime: '2099-06-01T09:30', timezone: 'America/New_York',
  });
  check('edit schedule (timezone change)', new Date(edited.data.scheduledAt).toISOString() === '2099-06-01T13:30:00.000Z', edited.data.scheduledAt);
  const toCancel = await call('POST', '/automations/scheduled-emails', {
    name: `Cancel ${RUN}`, sourceType: 'newsletter', newsletterId: newsletter.id, subject: 'never', recipientType: 'contacts', recipientEmails: [alice], localDatetime: '2099-01-01T10:00', timezone: 'UTC',
  });
  const cancelled = await call('POST', `/automations/scheduled-emails/${toCancel.data.id}/cancel`);
  check('cancel schedule', cancelled.data.status === 'cancelled');
  await q(`UPDATE scheduled_emails SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id IN ($1, $2)`, [scheduled.data.id, toCancel.data.id]);
  await runEngine();
  const [sentSchedule] = await q('SELECT * FROM scheduled_emails WHERE id = $1', [scheduled.data.id]);
  const [cancelledSchedule] = await q('SELECT * FROM scheduled_emails WHERE id = $1', [toCancel.data.id]);
  check('due schedule sent to group', sentSchedule.status === 'sent' && sentSchedule.sent_count === 2, `${sentSchedule.status} ${sentSchedule.sent_count}`);
  check('cancelled schedule never sends', cancelledSchedule.status === 'cancelled' && (await q('SELECT 1 FROM email_logs WHERE scheduled_email_id = $1', [toCancel.data.id])).length === 0);
  const [digest] = await q(`SELECT subject, html_content FROM email_logs WHERE scheduled_email_id = $1 AND recipient_email = $2`, [scheduled.data.id, alice]);
  check('scheduled email personalised incl. registeredAt', digest.subject === 'Digest for Alice' && /Dear Alice Wonder, joined \d{1,2} \w{3} \d{4}/.test(digest.html_content), digest.html_content.slice(0, 80));
  const editSent = await call('PUT', `/automations/scheduled-emails/${scheduled.data.id}`, { name: 'x' });
  check('sent schedule can no longer be edited', editSent.status === 400 || editSent.status === 409);

  /* ---------------------------------------------------------------- */
  console.log('\n8. Scheduled Date/Time trigger');
  const schedAuto = await call('POST', '/automations', {
    name: `Scheduled trigger ${RUN}`, triggerType: 'scheduled',
    triggerConfig: { localDatetime: '2099-03-01T08:00', timezone: 'Europe/London', repeat: 'weekly', audience: { type: 'contacts', emails: [alice, bob] } },
    workflow: { steps: [{ type: 'send_email', config: { sourceType: 'custom', subject: 'Weekly note for {{firstName}}', htmlContent: '<p>Hi</p>' } }] },
  });
  const schedActive = await call('POST', `/automations/${schedAuto.data.id}/activate`);
  check('next run computed from local time + tz', new Date(schedActive.data.nextRunAt).toISOString() === '2099-03-01T08:00:00.000Z', schedActive.data.nextRunAt);
  await q(`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [schedAuto.data.id]);
  await Promise.all([runEngine(), runEngine()]);
  const weekly = await logsFor(schedAuto.data.id);
  check('scheduled trigger fires once for its audience', weekly.length === 2, `${weekly.length}`);
  const [schedAfter] = await q('SELECT next_run_at FROM automations WHERE id = $1', [schedAuto.data.id]);
  check('repeat schedules the next occurrence', new Date(schedAfter.next_run_at) > new Date());

  /* ---------------------------------------------------------------- */
  console.log('\n9. Logs, webhook, retry, stats, delete');
  const logList = await call('GET', `/automations/email-logs?status=bounced&search=${encodeURIComponent(bounce)}`);
  check('filter logs by status + search', logList.data.total === 1);
  const summary = await call('GET', '/automations/email-logs/summary');
  check('log summary counts', summary.data.bounced >= 1 && summary.data.clicked >= 1);
  const preview = await call('GET', `/automations/email-logs/${carolLog.id}`);
  check('preview strips tracking', !preview.data.htmlContent.includes('/api/automations/track/') && preview.data.htmlContent.includes('href="https://example.com/start"'));
  const hookDenied = await call('POST', '/automations/email-events', { event: 'bounced', token: carolLog.tracking_token }, { auth: false });
  check('webhook requires secret', hookDenied.status === 403);
  const hookRes = await fetch(`${API}/automations/email-events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.EMAIL_WEBHOOK_SECRET || '' },
    body: JSON.stringify({ event: 'bounced', token: bobLogs[0].tracking_token, reason: 'Mailbox full' }),
  });
  check('webhook marks bounce', hookRes.status === 200 && (await q('SELECT status FROM email_logs WHERE id = $1', [bobLogs[0].id]))[0].status === 'bounced');
  const [failLog] = await q(`UPDATE email_logs SET status = 'failed', failed_at = NOW() WHERE id = $1 RETURNING id`, [flakyLog.id]);
  const retry = await call('POST', `/automations/email-logs/${failLog.id}/retry`);
  await runEngine();
  check('manual retry re-sends a failed email', retry.status === 200 && ['delivered', 'sent'].includes((await q('SELECT status FROM email_logs WHERE id = $1', [failLog.id]))[0].status));
  const stats = await call('GET', `/automations/${condAuto.data.id}/stats`);
  const firstStepStats = stats.data.emails.find((s) => s.stepId === 'first');
  check('per-step stats', firstStepStats?.sent === 2 && firstStepStats?.clicked === 1);
  const errs = await call('GET', `/automations/${onboarding.id}/errors`);
  check('errors list includes bounce', errs.data.some((e) => e.kind === 'email'));
  const list = await call('GET', '/automations');
  const row = list.data.find((a) => a.id === onboarding.id);
  check('dashboard row has stats', row.emailsSent >= 5 && row.lastRunAt && row.stepCount === 6);
  const dash = await call('GET', '/automations/summary');
  check('dashboard summary + engine status', dash.data.activeAutomations >= 3 && dash.data.engine.ticks > 0);
  const del = await call('DELETE', `/automations/${schedAuto.data.id}`);
  check('delete automation', del.status === 204 && (await q('SELECT 1 FROM automations WHERE id = $1', [schedAuto.data.id])).length === 0);
  check('sent logs kept after delete', (await q('SELECT 1 FROM email_logs WHERE recipient_email = $1 AND subject LIKE $2', [alice, 'Weekly note%'])).length === 1);

  const bad = await call('POST', '/automations', { name: 'Bad', triggerType: 'user_registered', workflow: { steps: [{ type: 'send_email', config: { subject: '' } }] } });
  check('validation rejects incomplete step', bad.status === 400);
  const noSend = await call('POST', '/automations', { name: 'Empty', triggerType: 'user_registered', workflow: { steps: [] } });
  const noSendActivate = await call('POST', `/automations/${noSend.data.id}/activate`);
  check('cannot activate without a Send email step', noSendActivate.status === 400);
  const nonAdmin = await call('POST', '/auth/login', { username: `alice_${RUN}`, password: 'Passw0rd!' }, { auth: false });
  const forbidden = await fetch(`${API}/automations`, { headers: { Authorization: `Bearer ${nonAdmin.data.accessToken}` } });
  check('non-admin users are blocked', forbidden.status === 403);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed:', failures);
  await pool.end();
  process.exit(failures.length ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
