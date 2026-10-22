/* eslint-disable no-console */
/**
 * Integration tests for campaign sending: the real API routes, queue tables and worker, talking to an
 * in-process mock SMTP server. No email leaves the machine.
 *
 * Needs a PostgreSQL database with the ADMS schema (a development copy, never production):
 *   CAMPAIGN_TEST=1 DB_HOST=... DB_PORT=... DB_DATABASE=adms_dev DB_USER=... DB_PASSWORD=... \
 *     node --test --test-concurrency=1 tests/campaign/sending.test.js
 * Everything it creates is prefixed with a run id and deleted at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fork } = require('child_process');
const { createMockSmtp } = require('./mockSmtp');

if (process.env.CAMPAIGN_TEST !== '1') {
  test('campaign integration tests (set CAMPAIGN_TEST=1 and point DB_* at a development database)', { skip: true }, () => {});
  return;
}

const RUN = `ct${Date.now().toString(36)}`;
const smtp = createMockSmtp({ tempFailures: 1 });
let api; let token; let adminId; let pool; let worker; let server;
const created = { newsletters: [], contacts: [] };

const setEnv = (port) => Object.assign(process.env, {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_FROM: 'campaigns@test.local',
  SMTP_USERNAME: 'tester', SMTP_PASSWORD: 'secret', JWT_SECRET: process.env.JWT_SECRET || 'campaign-test',
  PUBLIC_API_URL: 'https://adms.example.com', CAMPAIGN_RETRY_BASE_SECONDS: '1', CAMPAIGN_RETRY_MAX_SECONDS: '3',
  CAMPAIGN_MAX_ATTEMPTS: '3', CAMPAIGN_WORKER_POLL_MS: '200', CAMPAIGN_STALE_SENDING_SECONDS: '1',
  CAMPAIGN_SEND_CONCURRENCY: '4', CAMPAIGN_WEBHOOK_SECRET: 'hook-secret', SENDER_NAME: 'Aithent - Calypso'
});

const call = async (method, url, body, headers = {}) => {
  const r = await fetch(`${api}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const key = () => `${RUN}${Math.random().toString(36).slice(2, 12)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (sendId, predicate, timeoutMs = 30000) => {
  const end = Date.now() + timeoutMs;
  let p;
  while (Date.now() < end) {
    p = (await call('GET', `/newsletters/sends/${sendId}/progress`)).body;
    if (predicate(p)) return p;
    await sleep(150);
  }
  throw new Error(`timed out waiting for send ${sendId}: ${JSON.stringify(p?.status)} ${JSON.stringify(p?.counts)}`);
};
const isDone = (p) => ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(p.status);

const addContacts = async (emails) => {
  const { rows } = await pool.query(
    `INSERT INTO newsletter_contacts (name, email, source) SELECT split_part(e, '@', 1), e, 'test' FROM unnest($1::text[]) e
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [emails]);
  created.contacts.push(...rows.map((r) => r.id));
};
const makeCampaign = async (html = '<p>Hello {{firstName}} SAVED-V1</p>', subject = `Test ${RUN}`) => {
  const r = await call('POST', '/newsletters', { title: `Campaign ${RUN}`, subject, htmlContent: html });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  created.newsletters.push(r.body.id);
  return r.body;
};
const emailsFor = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}.${RUN}@example.test`);

test.before(async () => {
  setEnv(await smtp.listen());
  pool = require('../../src/config/db');
  await require('../../src/config/initDb')();
  const express = require('express');
  const jwt = require('jsonwebtoken');
  ({ campaignWorker: worker } = require('../../src/services/campaign/worker'));
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, password, email, full_name, is_admin) VALUES ($1, 'x', $2, 'Campaign Tester', TRUE) RETURNING id`,
    [`${RUN}admin`, `${RUN}admin@example.test`]);
  adminId = u.id;
  token = jwt.sign({ id: adminId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', require('../../src/routes/routes'));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: err.message }); }); // eslint-disable-line no-unused-vars
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  api = `http://127.0.0.1:${server.address().port}/api`;
  worker.start();
});

test.after(async () => {
  await worker.stop();
  const ids = created.newsletters;
  if (ids.length) {
    await pool.query(`DELETE FROM newsletter_events WHERE send_id IN (SELECT id FROM newsletter_sends WHERE newsletter_id = ANY($1))`, [ids]);
    await pool.query(`DELETE FROM newsletter_tracking WHERE newsletter_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM newsletter_sends WHERE newsletter_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM newsletters WHERE id = ANY($1)`, [ids]);
  }
  if (created.contacts.length) await pool.query(`DELETE FROM newsletter_contacts WHERE id = ANY($1)`, [created.contacts]);
  if (adminId) await pool.query(`DELETE FROM users WHERE id = $1`, [adminId]);
  server?.close();
  await smtp.close();
  await pool.end();
});

let bigSend; // reused by later tests

test('472 recipients: unknown users fail and are skipped, temporary errors are retried, the rest are accepted', async () => {
  const ok = emailsFor('ok', 410); const unknown = emailsFor('unknown', 40); const temp = emailsFor('temp', 20); const stuck = emailsFor('always451', 2);
  const all = [...ok, ...unknown, ...temp, ...stuck];
  assert.equal(all.length, 472);
  await addContacts(all);
  const campaign = await makeCampaign();
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: all, audienceLabel: 'Test list', idempotencyKey: key(), savedVersion: campaign.updated_at });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.equal(start.body.total, 472);
  const p = await waitFor(start.body.sendId, isDone, 60000);
  bigSend = { id: start.body.sendId, campaign, ok, unknown, temp, stuck };
  assert.equal(p.status, 'completed_with_errors');
  assert.equal(p.counts.total, 472);
  assert.equal(p.counts.accepted, 430, 'ok + temp addresses are accepted');
  assert.equal(p.counts.failed, 42, '40 unknown users + 2 that kept answering 451');
  assert.equal(p.counts.pending + p.counts.sending + p.counts.retryScheduled, 0);
  for (const e of [...ok, ...temp]) assert.equal(smtp.deliveredTo(e), 1, `${e} delivered exactly once`);
  for (const e of [...unknown, ...stuck]) assert.equal(smtp.deliveredTo(e), 0);
  for (const e of unknown) assert.equal(smtp.attempts.get(e.toLowerCase()), 1, 'permanent failures are not retried');
  for (const e of stuck) assert.equal(smtp.attempts.get(e.toLowerCase()), 3, 'temporary failures stop at CAMPAIGN_MAX_ATTEMPTS');

  const rows = (await call('GET', `/newsletters/sends/${bigSend.id}/recipients?filter=failed&pageSize=100`)).body;
  assert.equal(rows.total, 42);
  const unknownRow = rows.items.find((r) => r.email === unknown[0]);
  assert.equal(unknownRow.smtpCode, 550);
  assert.equal(unknownRow.errorClass, 'mailbox_unknown');
  assert.match(unknownRow.lastError, /User unknown/);
  assert.equal(unknownRow.attemptCount, 1);
  const stuckRow = rows.items.find((r) => r.email === stuck[0]);
  assert.equal(stuckRow.attemptCount, 3);
  assert.match(stuckRow.lastError, /Gave up after 3 attempts/);
});

test('report rows and dashboard use the same recipient-level numbers', async () => {
  const list = (await call('GET', `/newsletters/sends?newsletterId=${bigSend.campaign.id}`)).body;
  const row = list.items.find((r) => r.id === bigSend.id);
  assert.equal(row.accepted, 430);
  assert.equal(row.failedRecipients, 42);
  assert.equal(row.sentCount, 430);
  assert.equal(row.failedCount, 42);
  // Opens are unique per recipient; repeated pixel loads add to open events only.
  const { rows: [t] } = await pool.query(`SELECT tracking_token FROM newsletter_tracking WHERE send_id = $1 AND email = $2`, [bigSend.id, bigSend.ok[0]]);
  await fetch(`${api}/newsletters/track/${t.tracking_token}`);
  await fetch(`${api}/newsletters/track/${t.tracking_token}`);
  const p = (await call('GET', `/newsletters/sends/${bigSend.id}/progress`)).body;
  assert.equal(p.counts.opened, 1);
  assert.equal(p.counts.openEvents, 2);
  assert.equal(p.counts.accepted, 430, 'opens never change the accepted count');
});

test('retry failed retries only retryable recipients, never accepted ones', async () => {
  const before = smtp.delivered.length;
  const single = (await call('GET', `/newsletters/sends/${bigSend.id}/recipients?filter=failed&search=unknown0.`)).body.items[0];
  const refused = await call('POST', `/newsletters/sends/${bigSend.id}/recipients/${single.id}/retry`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'PERMANENT');
  const r = await call('POST', `/newsletters/sends/${bigSend.id}/retry-failed`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.retried, 2, 'only the two temporary failures');
  const p = await waitFor(bigSend.id, isDone, 30000);
  assert.equal(p.counts.accepted, 430);
  assert.equal(smtp.delivered.length, before, 'nothing accepted was sent again (the stuck addresses still fail)');
});

test('double-clicking Confirm & Send queues one send', async () => {
  const emails = emailsFor('dbl', 5); await addContacts(emails);
  const campaign = await makeCampaign();
  const k = key();
  const [a, b] = await Promise.all([1, 2].map(() => call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: k })));
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [202, 409]);
  const sendId = (a.status === 202 ? a : b).body.sendId;
  await waitFor(sendId, isDone);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM newsletter_sends WHERE newsletter_id = $1`, [campaign.id]);
  assert.equal(rows[0].n, 1);
  for (const e of emails) assert.equal(smtp.deliveredTo(e), 1);
});

test('unsaved editor content is sent only when chosen, and the snapshot ignores later edits', async () => {
  const emails = emailsFor('snap', 12); await addContacts(emails);
  const campaign = await makeCampaign('<p>SAVED-V1</p>');
  // Someone saves a newer version after the confirmation dialog was opened: sending the saved version is refused.
  await call('PUT', `/newsletters/${campaign.id}`, { title: campaign.title, subject: campaign.subject, htmlContent: '<p>SAVED-V2</p>' });
  const stale = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key(), savedVersion: campaign.updated_at });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONTENT_CHANGED');

  smtp.set('dataDelayMs', 120);
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key(), content: { subject: 'Edited subject', htmlContent: '<p>EDITOR-V3</p>' } });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.equal(start.body.contentSource, 'editor');
  await waitFor(start.body.sendId, (p) => p.counts.accepted >= 2);
  await call('PUT', `/newsletters/${campaign.id}`, { title: campaign.title, subject: campaign.subject, htmlContent: '<p>SAVED-V4 edited during the send</p>' });
  await waitFor(start.body.sendId, isDone);
  smtp.set('dataDelayMs', 0);
  const mails = smtp.delivered.filter((d) => emails.includes(d.to));
  assert.equal(mails.length, 12);
  assert.ok(mails.every((d) => d.html.includes('EDITOR-V3') && d.subject === 'Edited subject'), 'every email used the confirmed snapshot');
  const { rows: [saved] } = await pool.query(`SELECT html_content FROM newsletters WHERE id = $1`, [campaign.id]);
  assert.match(saved.html_content, /SAVED-V4/, 'sending the editor version did not overwrite the saved campaign');
});

test('cancel stops the remaining recipients and keeps accepted ones; resume sends only the rest', async () => {
  const emails = emailsFor('cxl', 60); await addContacts(emails);
  const campaign = await makeCampaign();
  smtp.set('dataDelayMs', 80);
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key() });
  const id = start.body.sendId;
  await waitFor(id, (p) => p.counts.accepted >= 8);
  const c = await call('POST', `/newsletters/sends/${id}/cancel`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const p = await waitFor(id, (x) => x.status === 'cancelled');
  await sleep(500);
  const delivered = emails.filter((e) => smtp.deliveredTo(e) > 0).length;
  assert.equal(p.counts.accepted, delivered, 'accepted count matches what the server received');
  assert.equal(p.counts.cancelled, 60 - delivered, 'everything not yet attempted is cancelled');
  assert.ok(p.counts.cancelled > 0);
  assert.equal(emails.filter((e) => smtp.deliveredTo(e) > 0).length, delivered, 'no emails went out after the cancel');

  smtp.set('dataDelayMs', 0);
  const r = await call('POST', `/newsletters/sends/${id}/resume`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const done = await waitFor(id, isDone);
  assert.equal(done.status, 'completed');
  assert.equal(done.counts.accepted, 60);
  for (const e of emails) assert.equal(smtp.deliveredTo(e), 1, 'resume never resends accepted emails');
});

test('pause holds the queue and resume continues from where it stopped', async () => {
  const emails = emailsFor('pse', 30); await addContacts(emails);
  const campaign = await makeCampaign();
  smtp.set('dataDelayMs', 60);
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key() });
  const id = start.body.sendId;
  await waitFor(id, (p) => p.counts.accepted >= 4);
  assert.equal((await call('POST', `/newsletters/sends/${id}/pause`, {})).status, 200);
  const paused = await waitFor(id, (p) => p.status === 'paused' && p.counts.sending === 0);
  await sleep(600);
  const after = (await call('GET', `/newsletters/sends/${id}/progress`)).body;
  assert.equal(after.counts.accepted, paused.counts.accepted, 'nothing is sent while paused');
  assert.ok(after.counts.pending > 0);
  smtp.set('dataDelayMs', 0);
  assert.equal((await call('POST', `/newsletters/sends/${id}/resume`, {})).status, 200);
  const done = await waitFor(id, isDone);
  assert.equal(done.counts.accepted, 30);
  for (const e of emails) assert.equal(smtp.deliveredTo(e), 1);
});

test('an SMTP login failure pauses the send with an actionable message instead of failing everyone', async () => {
  const emails = emailsFor('auth', 10); await addContacts(emails);
  const campaign = await makeCampaign();
  smtp.set('authFail', true);
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key() });
  const id = start.body.sendId;
  const p = await waitFor(id, (x) => x.status === 'paused');
  assert.equal(p.errorCode, 'smtp_auth');
  assert.match(p.pauseReason, /SMTP_USERNAME and SMTP_PASSWORD/);
  assert.equal(p.counts.failed, 0, 'no recipient is blamed for a server login problem');
  assert.equal(p.counts.pending, 10);
  smtp.set('authFail', false);
  await call('POST', `/newsletters/sends/${id}/resume`, {});
  const done = await waitFor(id, isDone);
  assert.equal(done.status, 'completed');
  assert.equal(done.counts.accepted, 10);
});

test('a worker killed mid-send resumes after restart without resending accepted emails', async () => {
  const emails = emailsFor('rst', 40); await addContacts(emails);
  const campaign = await makeCampaign();
  await worker.stop(); // the API process stops sending; a separate worker process takes over
  smtp.set('dataDelayMs', 100);
  const start = await call('POST', `/newsletters/${campaign.id}/send`, { recipientEmails: emails, idempotencyKey: key() });
  const id = start.body.sendId;
  const child = fork(path.join(__dirname, 'workerProcess.js'), [], { env: process.env, stdio: 'ignore' });
  await waitFor(id, (p) => p.counts.accepted >= 6, 20000);
  child.kill('SIGKILL');
  await sleep(300);
  smtp.set('dataDelayMs', 0);
  worker.stopping = false;
  worker.start(); // "after the restart"
  const done = await waitFor(id, (p) => isDone(p), 30000);
  for (const e of emails) assert.ok(smtp.deliveredTo(e) <= 1, `${e} was not sent twice`);
  const uncertain = done.counts.uncertain;
  console.log(`restart test: ${done.counts.accepted} accepted, ${uncertain} flagged "needs review" (were in flight when the worker was killed), ${emails.filter((e) => smtp.deliveredTo(e) > 1).length} duplicates`);
  assert.equal(done.counts.accepted + uncertain, 40, 'every recipient is either accepted or flagged for review');
  assert.equal(emails.filter((e) => smtp.deliveredTo(e) === 1).length >= done.counts.accepted, true);
  if (uncertain) {
    // Uncertain rows are not retried in bulk, and a single retry needs explicit confirmation.
    const row = (await call('GET', `/newsletters/sends/${id}/recipients?filter=uncertain`)).body.items[0];
    const r = await call('POST', `/newsletters/sends/${id}/recipients/${row.id}/retry`, {});
    assert.equal(r.body.code, 'MAY_DUPLICATE');
  }
});

test('delivery webhooks are applied once even when the provider retries them', async () => {
  const { rows: [t] } = await pool.query(`SELECT id, message_id FROM newsletter_tracking WHERE send_id = $1 AND status = 'accepted' AND message_id IS NOT NULL LIMIT 1`, [bigSend.id]);
  assert.ok(t?.message_id, 'accepted rows store the provider message id');
  const event = { events: [{ id: `${RUN}-evt-1`, type: 'delivered', messageId: `<${t.message_id}>` }] };
  const bad = await call('POST', '/newsletters/events/delivery', event, { 'X-ADMS-Webhook-Secret': 'wrong' });
  assert.equal(bad.status, 401);
  const first = await call('POST', '/newsletters/events/delivery', event, { 'X-ADMS-Webhook-Secret': 'hook-secret' });
  const again = await call('POST', '/newsletters/events/delivery', event, { 'X-ADMS-Webhook-Secret': 'hook-secret' });
  assert.equal(first.body.applied, 1);
  assert.equal(again.body.duplicate, 1);
  const p = (await call('GET', `/newsletters/sends/${bigSend.id}/progress`)).body;
  assert.equal(p.counts.delivered, 1);
  assert.equal(p.delivery.tracked, true);
});
