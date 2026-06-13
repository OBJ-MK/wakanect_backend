const express = require('express');
const router = express.Router();
const { getVapidPublicKey, subscribe, unsubscribe } = require('../controllers/pushController');
const { authMiddleware } = require('../middleware/auth');

// Clé publique VAPID — accessible sans auth (le front en a besoin avant l'abonnement)
router.get('/vapid-public-key', getVapidPublicKey);

// Gestion des abonnements — auth requise
router.post('/subscribe', authMiddleware, subscribe);
router.post('/unsubscribe', authMiddleware, unsubscribe);

module.exports = router;
