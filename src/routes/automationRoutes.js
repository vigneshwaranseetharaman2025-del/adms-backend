const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const c = require('../controllers/automationController');

const router = express.Router();
// Campaign role permissions: reading needs "Campaigns: view", changes need "Campaigns: edit & send".
const { byMethod } = require('../middleware/campaignAccess');

// Public: opened by recipients' mail clients / called by the mail provider.
router.get('/track/:token', c.trackOpen);
router.get('/click/:token', c.trackClick);
router.post('/email-events', c.emailEvent);

router.use(authenticateToken, byMethod);

// Literal paths must be registered before "/:id".
router.get('/summary', c.summary);
router.get('/meta', c.meta);
router.get('/engine/status', c.engineStatus);
router.post('/engine/run', c.engineRun);

router.get('/scheduled-emails', c.listScheduled);
router.post('/scheduled-emails', c.createScheduled);
router.put('/scheduled-emails/:id', c.updateScheduled);
router.post('/scheduled-emails/:id/cancel', c.cancelScheduled);
router.delete('/scheduled-emails/:id', c.deleteScheduled);

router.get('/email-logs', c.listLogs);
router.get('/email-logs/summary', c.logSummary);
router.get('/email-logs/groups', c.listLogGroups);
router.get('/email-logs/:id', c.logPreview);
router.post('/email-logs/:id/retry', c.retryLog);

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.getOne);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/activate', c.activate);
router.post('/:id/pause', c.pause);
router.post('/:id/resume', c.resume);
router.post('/:id/enroll', c.manualEnroll);
router.get('/:id/enrollments', c.enrollments);
router.get('/:id/enrollments/:enrollmentId/steps', c.enrollmentSteps);
router.get('/:id/stats', c.stepStats);
router.get('/:id/errors', c.errors);

module.exports = router;
