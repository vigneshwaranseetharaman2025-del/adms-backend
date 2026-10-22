const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const { list, sent, getOne, published, publishedOne, trackingPixel, trackClick, stats, createContact, removeContact, tracking, groups, createGroup, updateGroup, deleteGroup, uploadImage, uploadImages, getImage, getImageAsset, deleteImage, removeDraft, save, send, sendProgress, cancelSend, testSend, listTemplates, saveTemplate, removeTemplate } = require('../controllers/newsletterController');
const senderDomainController = require('../controllers/senderDomainController');
const contactController = require('../controllers/contactController');
const insights = require('../controllers/campaignInsightsController');
const { resend, previewAudience } = require('../controllers/newsletterController');
const { requireCampaignView, requireCampaignAdmin, byMethod } = require('../middleware/campaignAccess');
const sends = require('../controllers/campaignSendController');
const { rateLimit } = require('../middleware/rateLimit');

const sendActionLimit = rateLimit({ windowMs: 60000, max: 60 });
const webhookLimit = rateLimit({ windowMs: 60000, max: 1200, key: (req) => req.ip });

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Access is role-based (Administration → role → Campaigns permissions); administrators have full access.
// Before, every route below required is_admin, which is why colleagues could not see shared drafts.
const requireAdmin = requireCampaignAdmin;

router.get('/published', authenticateToken, published);
router.get('/published/:id', authenticateToken, publishedOne);
router.get('/sent', authenticateToken, requireCampaignView, sent);
router.get('/track/:token', trackingPixel);
router.get('/click/:token', trackClick);
// Provider delivery events (off unless CAMPAIGN_WEBHOOK_SECRET is set; authenticated by that secret).
router.post('/events/delivery', webhookLimit, sends.providerEvents);
// Contacts with directory details, custom field values, tags, lists and engagement.
router.get('/recipients', authenticateToken, requireCampaignView, contactController.listContacts);
router.get('/groups', authenticateToken, requireCampaignView, groups);
router.get('/stats', authenticateToken, requireCampaignView, stats);
router.get('/templates', authenticateToken, requireCampaignView, listTemplates);
// Email images must load in recipients' mail apps and on the blog for every employee,
// so these two read-only image routes are public. Upload and delete stay admin-only below.
router.get('/:id/images/:imageId', getImageAsset);
router.get('/:id/image', getImage);
router.use(authenticateToken);
// Any signed-in user may ask what they can do here (the screen uses it to show or hide actions).
router.get('/access', insights.access);
// Sender domain settings stay with administrators.
router.get('/sender-domains', requireAdmin, senderDomainController.list);
router.post('/sender-domains', requireAdmin, senderDomainController.create);
router.post('/sender-domains/:id/verify', requireAdmin, senderDomainController.verify);
router.put('/sender-domains/:id/default', requireAdmin, senderDomainController.setDefault);
router.delete('/sender-domains/:id', requireAdmin, senderDomainController.remove);
// Everything else: reading needs "Campaigns: view", changing or sending needs "Campaigns: edit & send".
router.use(byMethod);
router.get('/dashboard', insights.dashboard);
router.get('/sends', insights.listSends);
// Live sending: progress, recipient rows and the pause / resume / cancel / retry controls.
router.get('/sends/active', sends.active);
router.get('/sends/:sendId/progress', sends.progress);
router.get('/sends/:sendId/recipients', sends.recipients);
router.post('/sends/:sendId/pause', sendActionLimit, sends.pause);
router.post('/sends/:sendId/resume', sendActionLimit, sends.resume);
router.post('/sends/:sendId/cancel', sendActionLimit, sends.cancel);
router.post('/sends/:sendId/retry-failed', sendActionLimit, sends.retryFailed);
router.post('/sends/:sendId/recipients/:recipientId/retry', sendActionLimit, sends.retryRecipient);
router.get('/sends/:sendId', insights.getSend);
router.get('/sender-options', insights.senderOptions);
router.get('/sender-check', insights.senderCheck);
router.post('/preview-audience', previewAudience);
router.get('/:id/tracking', tracking);
router.get('/send-progress/:jobId', sendProgress);
router.post('/send-progress/:jobId/cancel', cancelSend);
// Custom contact fields and contact details (must come before the '/:id' routes).
router.get('/contact-fields', contactController.listFields);
router.post('/contact-fields', contactController.createField);
router.put('/contact-fields/:id', contactController.updateField);
router.delete('/contact-fields/:id', contactController.deleteField);
router.put('/contacts/details', contactController.updateDetails);
router.post('/contacts/tags/rename', contactController.renameTag);
router.post('/contacts/bulk-delete', contactController.bulkDelete);
router.put('/contacts/:id', contactController.updateContact);
router.get('/', list);
router.get('/:id', getOne);
router.post('/:id/image', upload.single('image'), uploadImage);
router.post('/:id/images', upload.array('images', 20), uploadImages);
router.delete('/:id/images/:imageId', deleteImage);
router.delete('/:id', removeDraft);
router.post('/', save);
router.put('/:id', save);
router.post('/:id/send', sendActionLimit, send);
router.post('/:id/resend', sendActionLimit, resend);
router.post('/groups', createGroup);
router.put('/groups/:id', updateGroup);
router.delete('/groups/:id', deleteGroup);
router.post('/contacts', createContact);
router.post('/contacts/import', contactController.importContacts);
router.delete('/contacts/:id', removeContact);
router.post('/:id/test-send', testSend);
router.post('/templates', saveTemplate);
router.delete('/templates/:id', removeTemplate);

module.exports = router;