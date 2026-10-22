/* Runs only the campaign worker, for the restart test (it gets killed with SIGKILL mid-send). */
const { campaignWorker } = require('../../src/services/campaign/worker');

campaignWorker.start();
process.send?.('ready');
setInterval(() => {}, 1000);
