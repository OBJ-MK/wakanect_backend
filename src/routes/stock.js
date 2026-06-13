const express = require('express');
const router = express.Router();
const {
  applyParsedMessage,
  updateStockManual,
  getPendingMessages,
} = require('../controllers/stockController');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authMiddleware);

// Lister les messages en attente de validation
router.get('/pending', requirePermission('dashboard.view'), getPendingMessages);

// Valider / publier un produit depuis la file
router.post('/apply/:parsedMessageId', requirePermission('products.publish'), applyParsedMessage);

// Modification manuelle du stock
router.patch('/products/:productId/stock', requirePermission('stock.edit'), updateStockManual);

module.exports = router;
