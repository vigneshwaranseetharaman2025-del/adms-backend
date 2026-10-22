/* Unit tests for SMTP error classification and retry backoff. No database or network needed.
 *   node --test tests/campaign/smtpErrors.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySmtpError, retryDelaySeconds } = require('../../src/services/campaign/smtpErrors');

const smtp = (responseCode, response, command = 'RCPT TO', code = 'EENVELOPE') => Object.assign(new Error(response), { responseCode, response, command, code });

test('550 unknown user at RCPT is a permanent recipient error (mailbox unknown)', () => {
  const c = classifySmtpError(smtp(550, '550 5.1.1 User unknown'));
  assert.equal(c.kind, 'permanent');
  assert.equal(c.mailboxUnknown, true);
  assert.equal(c.smtpCode, 550);
});

test('other 5xx recipient replies are permanent but not "mailbox unknown"', () => {
  const c = classifySmtpError(smtp(554, '554 5.6.0 Message rejected as spam', 'DATA'));
  assert.equal(c.kind, 'permanent');
  assert.equal(c.mailboxUnknown, false);
});

test('4xx replies are temporary and retried', () => {
  assert.equal(classifySmtpError(smtp(451, '451 4.3.0 Try again later')).kind, 'temporary');
  assert.equal(classifySmtpError(smtp(452, '452 4.2.2 Mailbox full')).kind, 'temporary');
});

test('421 and throttling replies are rate limits', () => {
  assert.equal(classifySmtpError(smtp(421, '421 4.7.0 Too many connections')).kind, 'rate_limit');
  assert.equal(classifySmtpError(smtp(450, '450 4.7.0 Rate limit exceeded')).kind, 'rate_limit');
});

test('authentication failures stop the whole send', () => {
  const c = classifySmtpError(Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }));
  assert.equal(c.kind, 'system');
  assert.equal(c.reason, 'auth');
});

test('sender / relay rejections are system errors, not bad recipients', () => {
  assert.equal(classifySmtpError(smtp(550, '550 5.7.1 Relaying denied')).kind, 'system');
  assert.equal(classifySmtpError(smtp(553, '553 Sender address rejected', 'MAIL FROM')).reason, 'sender');
});

test('connection problems before the message is transferred are retryable', () => {
  const c = classifySmtpError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ECONNECTION', command: 'CONN' }));
  assert.equal(c.kind, 'connection');
});

test('a connection lost during DATA is uncertain (may already be accepted)', () => {
  const c = classifySmtpError(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'DATA' }));
  assert.equal(c.kind, 'uncertain');
});

test('missing SMTP configuration is a system error', () => {
  const e = new Error('SMTP_HOST is missing'); e.name = 'MailConfigError';
  assert.equal(classifySmtpError(e).kind, 'system');
});

test('retry delay grows exponentially and is capped', () => {
  const opts = { baseSeconds: 60, maxSeconds: 3600 };
  const d1 = retryDelaySeconds(1, 'temporary', opts);
  const d3 = retryDelaySeconds(3, 'temporary', opts);
  assert.ok(d1 >= 51 && d1 <= 69, `first retry ~60s, got ${d1}`);
  assert.ok(d3 >= 204 && d3 <= 276, `third retry ~240s, got ${d3}`);
  assert.ok(retryDelaySeconds(20, 'temporary', opts) <= 3600);
  assert.ok(retryDelaySeconds(1, 'rate_limit', { baseSeconds: 10, maxSeconds: 3600 }) >= 100, 'rate limits wait at least ~2 minutes');
});
