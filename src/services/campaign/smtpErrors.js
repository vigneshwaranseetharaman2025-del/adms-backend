/**
 * Classifies a failed SMTP send so the campaign worker knows what to do next.
 *
 *   permanent   the server refused this recipient (550 unknown user, 553 bad mailbox, invalid address).
 *               Mark failed and continue. Never retried automatically.
 *   temporary   4xx reply for this message (451 try later, 452 mailbox full). Retry with backoff.
 *   rate_limit  the provider asked us to slow down (421/450/451/452 with throttling text). Retry later, slower.
 *   connection  could not reach or lost the server before the message was handed over. Safe to retry.
 *   uncertain   the connection dropped while the message itself was being transferred: the server may or
 *               may not have accepted it. Not retried automatically, to avoid duplicates.
 *   system      authentication, sender or relay configuration, or content the server will never accept.
 *               Affects every recipient, so the whole send is paused with an actionable message.
 */

const MAILBOX_UNKNOWN = /unknown user|user unknown|no such user|unknown recipient|recipient unknown|mailbox (?:unavailable|not found|does not exist)|does not exist|address rejected|invalid recipient|recipient (?:address )?rejected|no mailbox|not our customer|5\.1\.[0-9]/i;
const RELAY_OR_POLICY = /relay(?:ing)? (?:denied|not permitted|access denied)|not permitted to relay|sender address rejected|sender (?:not|is not) (?:allowed|authorized|authorised)|authentication required|must authenticate|5\.7\.[0-9]|spf|dmarc|not authorized to send|send as denied|sendasdenied/i;
const RATE_LIMIT = /rate limit|too many|throttl|slow down|exceeded|quota|4\.7\.0|temporarily deferred/i;
const CONNECTION_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EDNS', 'EPIPE', 'ETLS', 'EPROTOCOL']);
// Commands after which the message body may already be with the server.
const DATA_PHASE = new Set(['DATA', 'DATA END', 'BDAT', 'MESSAGE', 'STREAM']);

const text = (error) => `${error?.response || ''} ${error?.message || ''}`.trim();

const classifySmtpError = (error) => {
  const code = Number(error?.responseCode) || null;
  const errCode = String(error?.code || '');
  const command = String(error?.command || '').toUpperCase();
  const message = text(error).slice(0, 1000) || 'Unknown mail server error';
  const result = (kind, extra = {}) => ({ kind, smtpCode: code, errorCode: errCode || null, command: command || null, message, ...extra });

  if (error?.name === 'MailConfigError') return result('system', { reason: 'not_configured' });
  if (errCode === 'EAUTH' || code === 535 || code === 534 || code === 530 || /invalid login|authentication (?:failed|unsuccessful)|username and password not accepted/i.test(message)) {
    return result('system', { reason: 'auth' });
  }
  if (errCode === 'EMESSAGE') return result('system', { reason: 'content' });

  if (code && code >= 500) {
    if (command.startsWith('MAIL') || RELAY_OR_POLICY.test(message)) return result('system', { reason: 'sender' });
    if (code === 552 && command.startsWith('DATA')) return result('system', { reason: 'content' }); // message too large
    return result('permanent', { mailboxUnknown: MAILBOX_UNKNOWN.test(message) || ([550, 551, 553].includes(code) && command.startsWith('RCPT')) });
  }
  if (code && code >= 400) {
    if (code === 421 || RATE_LIMIT.test(message)) return result('rate_limit');
    return result('temporary');
  }
  if (errCode === 'EENVELOPE') return result('permanent', { mailboxUnknown: false }); // e.g. no valid recipient address
  if (CONNECTION_CODES.has(errCode) || /timeout|timed out|connection (?:closed|lost|reset)|socket|greeting never received/i.test(message)) {
    return result(DATA_PHASE.has(command) ? 'uncertain' : 'connection');
  }
  return result('temporary');
};

/** Seconds to wait before attempt `attempt + 1` (attempt is the number already made). */
const retryDelaySeconds = (attempt, kind, { baseSeconds = 60, maxSeconds = 3600 } = {}) => {
  const base = kind === 'rate_limit' ? Math.max(baseSeconds, 120) : baseSeconds;
  const delay = base * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.min(maxSeconds, Math.round(delay * jitter));
};

const RETRYABLE = new Set(['temporary', 'rate_limit', 'connection']);
// What "Retry failed" may pick up: retryable classes plus rows from the old sender whose cause was never recorded.
const MANUALLY_RETRYABLE = new Set([...RETRYABLE, 'unknown', 'gave_up']);

module.exports = { classifySmtpError, retryDelaySeconds, RETRYABLE, MANUALLY_RETRYABLE };
