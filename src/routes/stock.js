const express = require('express');
const router = express.Router();
const {
  applyParsedMessage,
  updateStockManual,
  getPendingMessages,
} = require('../controllers/stockController');
const { authMiddleware } = require('../middleware/auth');

// Toutes les routes stock nécessitent une authentification
router.use(authMiddleware);

// Lister les messages en attente de validation
router.get('/pending', getPendingMessages);

// Appliquer un message parsé au stock
router.post('/apply/:parsedMessageId', applyParsedMessage);

// Modification manuelle du stock d'un produit
router.patch('/products/:productId/stock', updateStockManual);

module.exports = router;
