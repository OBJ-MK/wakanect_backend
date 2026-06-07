const express = require('express');
const router = express.Router();
const {
  verifyWebhook,
  receiveWebhook,
  verifySignature,
} = require('../controllers/webhookController');

// GET /webhook — vérification Meta
router.get('/', verifyWebhook);

// POST /webhook — messages entrants (avec vérification signature HMAC)
router.post('/', verifySignature, receiveWebhook);

module.exports = router;
