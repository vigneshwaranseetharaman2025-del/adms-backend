const { EventEmitter } = require('events');
const queue = require('../../models/sendQueueModel');
const newsletterModel = require('../../models/newsletterModel');
const { mailer } = require('../../config/mailer');
const { resolveSender, SenderError } = require('../senderIdentity');
const { renderTemplate, getRecipientProfile } = require('../automation/personalization');
const { classifySmtpError, retryDelaySeconds, RETRYABLE } = require('./smtpErrors');
const { trackingLinks } = require('./trackingOrigin');

const intEnv = (name, fallback, min, max) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

/** Worker settings; every value can be changed with an environment variable. */
const readConfig = () => ({
  concurrency: intEnv('CAMPAIGN_SEND_CONCURRENCY', 3, 1, 10),       // emails in flight at once
  perMinute: intEnv('CAMPAIGN_MAX_PER_MINUTE', 0, 0, 100000),       // 0 = no rate limit
  maxAttempts: intEnv('CAMPAIGN_MAX_ATTEMPTS', 4, 1, 10),           // per recipient, for temporary errors
  retryBaseSeconds: intEnv('CAMPAIGN_RETRY_BASE_SECONDS', 60, 1, 3600),
  retryMaxSeconds: intEnv('CAMPAIGN_RETRY_MAX_SECONDS', 3600, 1, 86400),
  pollMs: intEnv('CAMPAIGN_WORKER_POLL_MS', 5000, 100, 60000),
  connectionErrorsBeforePause: intEnv('CAMPAIGN_PAUSE_AFTER_CONNECTION_ERRORS', 5, 1, 100),
  samePermanentErrorsBeforePause: intEnv('CAMPAIGN_PAUSE_AFTER_SAME_REJECTIONS', 25, 2, 10000),
  staleSeconds: intEnv('CAMPAIGN_STALE_SENDING_SECONDS', 120, 1, 3600) // longer than any single SMTP attempt
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_MESSAGES = {
  auth: 'The mail server rejected the login. Check SMTP_USERNAME and SMTP_PASSWORD on the server, then resume.',
  sender: 'The mail server refused the sender address or relaying. Check that this From address is allowed on the SMTP account and that the domain is verified, then resume.',
  content: 'The mail server will not accept this email content (for example it is too large). Edit the campaign and send it again.',
  not_configured: 'Email is not configured on the server (SMTP_HOST is missing). Ask an administrator to configure SMTP, then resume.'
};

/**
 * Sends queued campaign emails one recipient at a time, from the database.
 *  - A recipient-level failure never stops the send: permanent errors fail that recipient, temporary
 *    ones are retried with exponential backoff up to maxAttempts.
 *  - Problems that would affect everyone (login, sender, server unreachable, the same rejection over and
 *    over) pause the send with a clear reason instead of burning through the list.
 *  - Pause and cancel are checked between batches, so they take effect within a few emails.
 *  - State lives in the database, so after a restart the send continues with the recipients not yet
 *    processed; accepted recipients are never sent again.
 */
class CampaignWorker extends EventEmitter {
  constructor({ sendMail = (m) => mailer.sendMail(m), config } = {}) {
    super();
    this.sendMail = sendMail;
    this.configOverride = config || null;
    this.runners = new Map();
    this.timer = null;
    this.stopping = false;
  }

  get config() { return { ...readConfig(), ...(this.configOverride || {}) }; }

  start() {
    if (this.timer) return;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.runners.values()]);
  }

  /** Makes sure a runner is working on this send (no-op when one already is). */
  kick(sendId) {
    if (this.stopping || this.runners.has(sendId)) return;
    const runner = this.run(sendId)
      .catch((error) => console.error(`[campaign] send ${sendId} worker error:`, error.message))
      .finally(() => { this.runners.delete(sendId); });
    this.runners.set(sendId, runner);
  }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const stale = await queue.reconcileStale(this.config.staleSeconds);
      new Set(stale.map((r) => r.send_id)).forEach((id) => this.emit('update', { sendId: id }));
      for (const id of await queue.runnableSendIds()) this.kick(id);
    } catch (error) {
      console.error('[campaign] worker tick failed:', error.message);
    } finally {
      this.ticking = false;
    }
  }

  async pause(send, reason, code, lastError) {
    await queue.transition(send.id, ['sending', 'queued'], 'paused', { pause_reason: reason, error: lastError ? String(lastError).slice(0, 1000) : reason, error_code: code, paused_at: new Date() });
    console.warn(`[campaign] send ${send.id} paused: ${reason}`);
    this.emit('update', { sendId: send.id, initiatedBy: send.initiated_by });
  }

  async run(sendId) {
    let send = await queue.getSend(sendId);
    if (!send || !queue.RUNNABLE.includes(send.status)) return;
    if (send.status === 'queued') send = (await queue.transition(sendId, ['queued'], 'sending')) ? await queue.getSend(sendId) : send;
    const notify = () => this.emit('update', { sendId, initiatedBy: send.initiated_by });
    notify();

    if (send.status === 'cancelling') { await this.finishCancel(send); return; }

    let sender;
    try {
      sender = await resolveSender({ fromName: send.from_name, fromEmail: send.from_email, replyTo: send.reply_to });
    } catch (error) {
      if (error instanceof SenderError) { await this.pause(send, `${error.message} Fix the sender and resume.`, error.code); return; }
      throw error;
    }
    const content = {
      subject: send.snapshot_subject ?? send.subject ?? send.newsletter_subject ?? '',
      html: send.snapshot_html ?? send.newsletter_html ?? '',
      links: trackingLinks(send.tracking_origin)
    };
    const state = { connectionErrors: 0, lastRejection: null, sameRejections: 0, slowUntil: 0 };

    while (!this.stopping) {
      const { config } = this;
      const current = await queue.getSend(sendId);
      if (!current) return;
      if (current.status === 'cancelling') { await this.finishCancel(current); return; }
      if (current.status !== 'sending') { notify(); return; } // paused or finished elsewhere

      if (state.slowUntil > Date.now()) await sleep(Math.min(state.slowUntil - Date.now(), config.pollMs));
      const started = Date.now();
      const claimed = await queue.claimDue(sendId, config.concurrency);
      if (!claimed.length) {
        const c = await queue.counts(sendId, [...RETRYABLE]);
        if (c.sending > 0) { await sleep(Math.min(config.pollMs, 2000)); continue; } // another attempt still in flight
        if (c.retryScheduled > 0) {
          const at = await queue.nextRetryAt(sendId);
          await sleep(Math.max(200, Math.min(config.pollMs, new Date(at).getTime() - Date.now())));
          continue;
        }
        await this.finish(current, c);
        return;
      }

      const results = await Promise.all(claimed.map((row) => this.deliver(current, sender, content, row, state)));
      notify();

      const system = results.find((r) => r.system);
      if (system) {
        await this.pause(current, SYSTEM_MESSAGES[system.system.reason] || system.system.message, `smtp_${system.system.reason || 'system'}`, system.system.message);
        return;
      }
      if (state.connectionErrors >= config.connectionErrorsBeforePause) {
        await this.pause(current, `The mail server could not be reached ${state.connectionErrors} times in a row. Check the SMTP server and network, then resume. Nothing was lost: unsent recipients are still queued.`, 'smtp_unreachable', state.lastConnectionError);
        return;
      }
      if (state.sameRejections >= config.samePermanentErrorsBeforePause) {
        await this.pause(current, `${state.sameRejections} recipients in a row were refused with the same error ("${String(state.lastRejection).slice(0, 160)}"). This usually means a sender or account problem rather than bad addresses. Check it, then resume.`, 'smtp_repeated_rejection', state.lastRejection);
        return;
      }
      if (results.some((r) => r.rateLimited)) state.slowUntil = Date.now() + 15000;
      if (config.perMinute > 0) {
        const budget = (60000 / config.perMinute) * claimed.length;
        const wait = budget - (Date.now() - started);
        if (wait > 0) await sleep(wait);
      }
    }
  }

  /** One attempt for one recipient. Always resolves; the outcome is written to the recipient row. */
  async deliver(send, sender, content, row, state) {
    const { config } = this;
    try {
      const profile = await getRecipientProfile(row.email);
      let html = renderTemplate(content.html, profile, { html: true });
      if (content.links) {
        const { open, click } = content.links(row.trackingToken);
        if (click) html = html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (m, url) => `href="${click(url)}"`);
        if (open) html = `${html}<img src="${open}" width="1" height="1" alt="" style="display:none" />`;
      }
      const info = await this.sendMail({
        ...sender.headers,
        to: row.email,
        subject: renderTemplate(content.subject, profile),
        html,
        headers: { 'X-ADMS-Send': String(send.id), 'X-ADMS-Recipient': String(row.id) }
      });
      await queue.markAccepted(row.id, { messageId: info?.messageId, response: info?.response });
      state.connectionErrors = 0;
      state.sameRejections = 0;
      this.emit('activity', { sendId: send.id, email: row.email, status: 'accepted' });
      return { ok: true };
    } catch (error) {
      const c = classifySmtpError(error);
      if (c.kind === 'system') {
        await queue.releaseClaim(row.id);
        return { system: c };
      }
      if (c.kind === 'permanent') {
        await queue.markAttemptFailed(row.id, { status: 'failed', errorClass: c.mailboxUnknown ? 'mailbox_unknown' : 'permanent', smtpCode: c.smtpCode, error: c.message });
        state.connectionErrors = 0;
        state.sameRejections = c.message === state.lastRejection ? state.sameRejections + 1 : 1;
        state.lastRejection = c.message;
        return { failed: true };
      }
      if (c.kind === 'uncertain') {
        await queue.markAttemptFailed(row.id, {
          status: 'uncertain', errorClass: 'uncertain', smtpCode: c.smtpCode,
          error: `The connection dropped while the email was being transferred, so it may or may not have been accepted: ${c.message}`
        });
        state.connectionErrors += 1;
        state.lastConnectionError = c.message;
        return { uncertain: true };
      }
      // temporary, rate_limit, connection: retry with backoff until maxAttempts.
      if (c.kind === 'connection') { state.connectionErrors += 1; state.lastConnectionError = c.message; } else state.connectionErrors = 0;
      if (row.attemptCount >= config.maxAttempts) {
        await queue.markAttemptFailed(row.id, { status: 'failed', errorClass: c.kind, smtpCode: c.smtpCode, error: `Gave up after ${row.attemptCount} attempts: ${c.message}` });
        return { failed: true, rateLimited: c.kind === 'rate_limit' };
      }
      const delay = retryDelaySeconds(row.attemptCount, c.kind, { baseSeconds: config.retryBaseSeconds, maxSeconds: config.retryMaxSeconds });
      await queue.markAttemptFailed(row.id, { status: 'retry_scheduled', errorClass: c.kind, smtpCode: c.smtpCode, error: c.message, nextRetryAt: new Date(Date.now() + delay * 1000) });
      return { retry: true, rateLimited: c.kind === 'rate_limit' };
    }
  }

  /** Closes a send whose recipients have all been processed. */
  async finish(send, c) {
    if (c.pending + c.sending + c.retryScheduled > 0) return;
    const problems = c.failed + c.uncertain;
    const status = c.accepted === 0 && problems > 0 ? 'failed' : problems > 0 ? 'completed_with_errors' : 'completed';
    const done = await queue.transition(send.id, ['sending'], status, { finished_at: new Date(), pause_reason: null });
    if (!done) return;
    await queue.storeTotals(send.id);
    await this.markCampaignSent(send, c.accepted);
    this.emit('update', { sendId: send.id, initiatedBy: send.initiated_by, finished: status });
  }

  async finishCancel(send) {
    await queue.cancelRemaining(send.id);
    const done = await queue.transition(send.id, ['cancelling'], 'cancelled', { finished_at: new Date() });
    await queue.storeTotals(send.id);
    if (done) {
      const c = await queue.counts(send.id, [...RETRYABLE]);
      await this.markCampaignSent(send, c.accepted);
    }
    this.emit('update', { sendId: send.id, initiatedBy: send.initiated_by, finished: 'cancelled' });
  }

  /** The first send that got emails out marks the campaign as sent. A resend never changes the original. */
  async markCampaignSent(send, accepted) {
    if (send.kind !== 'original' || accepted <= 0) return;
    const fresh = await queue.getSend(send.id);
    if (fresh?.newsletter_status !== 'sent') await newsletterModel.markNewsletterSent(send.newsletter_id, accepted);
  }
}

const campaignWorker = new CampaignWorker();

module.exports = { CampaignWorker, campaignWorker, readConfig };
