// server.js
const express = require('express');
const https = require('https');
const cors = require('cors');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./src/swagger/swaggerDoc');
require('dotenv').config();
const initDb = require('./src/config/initDb');
const routes = require('./src/routes/routes');
const createSocketServer = require('./src/config/socket');
const { registerChatSocket } = require('./src/socket/chatSocket');
const fs = require('fs');
const automationScheduler = require('./src/services/automation/scheduler');
const { verifyMailer } = require('./src/config/mailer');
const { campaignWorker } = require('./src/services/campaign/worker');
const { trackingStatus } = require('./src/services/campaign/trackingOrigin');

const app = express();
const options = {
    key: fs.readFileSync("./cert/key.pem"),
    cert: fs.readFileSync("./cert/cert.pem"),
};

const httpServer = https.createServer(options, app);
const io = createSocketServer(httpServer);
registerChatSocket(io);
app.set('io', io); // lets REST controllers (e.g. group participant changes) push live socket updates

// Campaign sending: tell connected clients a send changed (at most once a second per send, plus every
// finish). Only the send id goes out; clients fetch the details through the authorised API.
const lastCampaignEmit = new Map();
campaignWorker.on('update', ({ sendId, finished }) => {
  const now = Date.now();
  if (!finished && now - (lastCampaignEmit.get(sendId) || 0) < 1000) return;
  lastCampaignEmit.set(sendId, now);
  io.emit('campaign:send', { sendId, finished: finished || null });
});
const PORT = process.env.PORT || 5000;



app.use(cors());
app.use('/api/newsletters', express.json({ limit: '10mb' }));
app.use(express.json());

if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'local') {
  app.use(
    '/files',
    express.static(path.join(__dirname, 'uploads'), {
      dotfiles: 'deny',
      maxAge: '30d',
      index: false,
    })
  );
}

app.use('/api', routes);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server Error' });
});

initDb()
  .then(() => {
    // Use httpServer.listen (not app.listen) so Socket.IO shares the same
    // underlying HTTP server/port instead of needing a second one.
    httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTPS Server running on https://192.168.193.68:${PORT}`);
    automationScheduler.start();
    campaignWorker.start(); // resumes queued and in-progress campaign sends left by a restart
    if (process.env.PUBLIC_API_URL && trackingStatus(process.env.PUBLIC_API_URL).private) {
      console.warn('[campaign] PUBLIC_API_URL is a private address: recipients outside your network cannot load open pixels or tracked links.');
    }
    void verifyMailer(); // logs whether SMTP works, so mail problems show up at startup
});
  })
  .catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

// Let in-flight campaign emails finish and record their result before the process exits, so a planned
// restart does not leave recipients in the "may or may not have been accepted" state.
const shutdown = (signal) => {
  console.log(`[server] ${signal} received, finishing in-flight campaign emails...`);
  Promise.race([campaignWorker.stop(), new Promise((r) => setTimeout(r, 25000))]).finally(() => process.exit(0));
};
['SIGTERM', 'SIGINT'].forEach((signal) => process.once(signal, () => shutdown(signal)));

