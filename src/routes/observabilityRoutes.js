const express = require('express');
const router = express.Router();
const observabilityController = require('../controllers/observabilityController');
const { apiKeyAuth } = require('../middleware/auth');

router.use(apiKeyAuth);

// Public endpoints (no auth required)
router.get('/ping', observabilityController.ping);
router.get('/health', observabilityController.healthCheck);

// Protected endpoints (require API key)
router.get('/version', observabilityController.getVersion);
router.get('/environment', observabilityController.getEnvironment);
router.get('/status', observabilityController.getStatus);

// Dangerous endpoints (require API key)
router.post('/stop', observabilityController.stopServer);
router.post('/restart', observabilityController.restartServer);

module.exports = router;
