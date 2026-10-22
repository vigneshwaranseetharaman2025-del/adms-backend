const express = require('express');
const authRoutes = require('./authRoutes');
const documentRoutes = require('./documentRoutes');
const galleryRoutes = require('./galleryRoutes');
const chatRoutes = require('./chatRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const newsletterRoutes = require('./newsletterRoutes');
const automationRoutes = require('./automationRoutes');
const emailAssetRoutes = require('./emailAssetRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/documents', documentRoutes);
router.use('/gallery', galleryRoutes);
router.use('/chat', chatRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/newsletters', newsletterRoutes);
router.use('/automations', automationRoutes);
router.use('/email-assets', emailAssetRoutes);

module.exports = router;