const express = require('express');
const router = express.Router();
const { getProducts, createProduct, updateProduct, deleteProduct, getPublicCatalogue, deleteProductImage, setProductImagePrimary } = require('../controllers/productController');
const { createOrder, getOrders, updateOrderStatus, getDashboardStats } = require('../controllers/orderController');
const { authMiddleware } = require('../middleware/auth');

// ─── Catalogue public (pas d'auth) ────────────────────────────────────────────
router.get('/boutique/:slug', getPublicCatalogue);

// ─── Commande client final (pas d'auth) ───────────────────────────────────────
router.post('/orders/public', createOrder);

// ─── Routes protégées (dashboard commerçant) ──────────────────────────────────
router.use(authMiddleware);

// Dashboard stats
router.get('/dashboard/stats', getDashboardStats);

// Produits
router.get('/products', getProducts);
router.post('/products', createProduct);
router.patch('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);

// Images produit (R2)
router.delete('/products/:id/images/:imageId', deleteProductImage);
router.patch('/products/:id/images/:imageId/primary', setProductImagePrimary);

// Commandes
router.get('/orders', getOrders);
router.patch('/orders/:id/status', updateOrderStatus);

module.exports = router;
