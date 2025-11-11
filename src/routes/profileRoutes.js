const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController.js');
const { apiKeyAuth } = require('../middleware/auth');

router.use(apiKeyAuth);

// Get my profile
router.get('/:instanceId', profileController.getProfile);

// Update profile name
router.put('/:instanceId/name', profileController.updateProfileName);

// Update profile status (about)
router.put('/:instanceId/status', profileController.updateProfileStatus);

// Update profile picture
router.put('/:instanceId/picture', profileController.updateProfilePicture);

// Delete profile picture
router.delete('/:instanceId/picture', profileController.deleteProfilePicture);

module.exports = router;
