const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const vitalController = require('../controllers/vitalController');
const reportController = require('../controllers/reportController');

// Authentication endpoints
router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);

// Vitals logging endpoints (Protected)
router.post('/vitals/log', authController.verifyToken, vitalController.saveSessionLog);
router.get('/vitals/history', authController.verifyToken, vitalController.getHistoricalTrends);
router.get('/vitals/latest', authController.verifyToken, vitalController.getLatestVitals);

// Report generation endpoints (Protected)
router.get('/report', authController.verifyToken, reportController.generatePDFReport);

module.exports = router;
