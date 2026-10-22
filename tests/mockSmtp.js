/**
 * In-process SMTP server for campaign tests. Nothing leaves the machine.
 * Behaviour depends on the recipient address (local part prefix):
 *   unknown*   550 5.1.1 User unknown (permanent, at RCPT TO)
 *   temp*      451 4.3.0 at RCPT TO for the first `tempFailures` attempts, then accepted
 *   always451* 451 every time
 *   throttle*  421 4.7.0 rate limit, first attempt only
 *   anything else: accepted
 * set('authFail', true) makes AUTH fail with 535; set('dataDelayMs', n) slows each accepted message.
 */
const net = require('net');

const createMockSmtp = ({ tempFailures = 1 } = {}) => {
  const state = { authFail: false, dataDelayMs: 0, tempFailures };
  const attempts = new Map(); // email -> RCPT attempts
  const delivered = [];       // { to, subject, html } for every accepted message
  const server = net.createServer((sock) => {
    let rcpt = null; let inData = false; let buf = ''; let body = []; let subject = '';
    const w = (l) => { if (!sock.destroyed) sock.write(`${l}\r\n`); };
    w('220 mock ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const to = rcpt; const html = body.join('\n'); const subj = subject;
            setTimeout(() => { delivered.push({ to, subject: subj, html }); w('250 2.0.0 queued as mock'); }, state.dataDelayMs);
          } else {
            if (/^Subject:/i.test(line)) subject = line.replace(/^Subject:\s*/i, '');
            body.push(line);
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd.startsWith('AUTH')) w(state.authFail ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 ok');
        else if (cmd.startsWith('MAIL FROM')) { body = []; subject = ''; w('250 ok'); }
        else if (cmd.startsWith('RCPT TO')) {
          rcpt = (line.match(/<(.+)>/) || [])[1]?.toLowerCase() || '';
          const local = rcpt.split('@')[0];
          const n = (attempts.get(rcpt) || 0) + 1; attempts.set(rcpt, n);
          if (local.startsWith('unknown')) w('550 5.1.1 <' + rcpt + '>: Recipient address rejected: User unknown');
          else if (local.startsWith('always451')) w('451 4.3.0 Temporary server error, try again later');
          else if (local.startsWith('temp') && n <= state.tempFailures) w('451 4.3.0 Temporary server error, try again later');
          else if (local.startsWith('throttle') && n === 1) w('421 4.7.0 Rate limit exceeded, slow down');
          else w('250 ok');
        } else if (cmd === 'DATA') { inData = true; w('354 go'); }
        else if (cmd === 'QUIT') { w('221 bye'); sock.end(); }
        else w('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return {
    state,
    attempts,
    delivered,
    set: (key, value) => { state[key] = value; },
    deliveredTo: (email) => delivered.filter((d) => d.to === email.toLowerCase()).length,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
};

module.exports = { createMockSmtp };
