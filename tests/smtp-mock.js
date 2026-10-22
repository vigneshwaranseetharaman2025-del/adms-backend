// Local test SMTP server (no dependencies). Accepts mail on port 2525, logs to tests/mail.log.
// Addresses containing "bounce" get a 550 (permanent); "flaky" get a 451 twice, then succeed.
//   node tests/smtp-mock.js
const net = require('net'); const fs = require('fs');
const flakyCount = {}; const LOG = process.env.SMTP_MOCK_LOG || require('path').join(__dirname, 'mail.log');
net.createServer((sock) => {
  let rcpt = null, inData = false, buf = '';
  const w = (l) => sock.write(l + '\r\n');
  w('220 mock ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; fs.appendFileSync(LOG, `DELIVERED ${rcpt}\n`); w('250 2.0.0 queued as mock'); }
        else if (/^Subject:/i.test(line)) fs.appendFileSync(LOG, `SUBJECT ${rcpt} ${line}\n`);
        else if (line.includes('Welcome,') || line.includes('Hi ')) fs.appendFileSync(LOG, `BODY ${rcpt} ${line.slice(0,120)}\n`);
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO')) { sock.write('250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
      else if (cmd.startsWith('AUTH')) w('235 ok');
      else if (cmd.startsWith('MAIL FROM')) w('250 ok');
      else if (cmd.startsWith('RCPT TO')) {
        rcpt = line.match(/<(.+)>/)[1].toLowerCase();
        if (rcpt.includes('bounce')) { w('550 5.1.1 User unknown'); fs.appendFileSync(LOG, `BOUNCED ${rcpt}\n`); }
        else if (rcpt.includes('flaky') && (flakyCount[rcpt] = (flakyCount[rcpt] || 0) + 1) <= 2) { w('451 4.3.0 try later'); fs.appendFileSync(LOG, `TEMPFAIL ${rcpt}\n`); }
        else w('250 ok');
      }
      else if (cmd === 'DATA') { inData = true; w('354 go'); }
      else if (cmd === 'QUIT') { w('221 bye'); sock.end(); }
      else if (cmd === 'RSET') w('250 ok');
      else w('250 ok');
    }
  });
  sock.on('error', () => {});
}).listen(2525, () => console.log('mock smtp on 2525'));
