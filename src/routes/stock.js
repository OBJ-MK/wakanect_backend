'use strict';

const express = require('express');
const router  = express.Router();
const {
  applyParsedMessage,
  ignoreMessage,
  updateStockManual,
  getPendingMessages,
} = require('../controllers/stockController');
const { getProducts } = require('../controllers/productController');
const { authMiddleware }    = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authMiddleware);

// Liste produits (même logique que GET /api/products, alias stock)
router.get('/products', requirePermission('dashboard.view'), getProducts);

// Modifier stock + prix d'un produit
router.patch('/products/:productId/stock', requirePermission('stock.edit'), updateStockManual);

// Candidats en attente de validation
router.get('/pending', requirePermission('dashboard.view'), getPendingMessages);

// Valider / publier un candidat
router.post('/apply/:parsedMessageId', requirePermission('products.publish'), applyParsedMessage);

// Ignorer un candidat (action tertiaire)
router.post('/ignore/:parsedMessageId', requirePermission('products.publish'), ignoreMessage);

module.exports = router;
