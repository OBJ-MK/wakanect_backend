const express = require('express');
const router = express.Router();
const {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getPublicCatalogue,
  deleteProductImage,
  setProductImagePrimary,
} = require('../controllers/productController');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  updateOrderPayment,
  getDashboardStats,
} = require('../controllers/orderController');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

// ─── Catalogue public (pas d'auth) ────────────────────────────────────────────
router.get('/boutique/:slug', getPublicCatalogue);

// ─── Commande client final (pas d'auth) ───────────────────────────────────────
router.post('/orders/public', createOrder);

// ─── Routes protégées (dashboard commerçant) ──────────────────────────────────
router.use(authMiddleware);

// Dashboard stats
router.get('/dashboard/stats', requirePermission('dashboard.view'), getDashboardStats);

// Produits — lectures
router.get('/products', requirePermission('dashboard.view'), getProducts);

// Produits — écritures
router.post('/products', requirePermission('products.edit'), createProduct);
router.patch('/products/:id', requirePermission('products.edit'), updateProduct);
router.delete('/products/:id', requirePermission('products.edit'), deleteProduct);

// Images produit (R2)
router.delete('/products/:id/images/:imageId', requirePermission('products.edit'), deleteProductImage);
router.patch('/products/:id/images/:imageId/primary', requirePermission('products.edit'), setProductImagePrimary);

// Commandes — lecture
router.get('/orders', requirePermission('dashboard.view'), getOrders);

// Commandes — transitions de statut (permission dépend du statut cible)
router.patch(
  '/orders/:id/status',
  requirePermission((req) => {
    const s = req.body.status;
    if (s === 'confirmed' || s === 'delivered') return 'orders.confirm';
    if (s === 'cancelled') return 'orders.cancel';
    return null;
  }),
  updateOrderStatus
);

// Commandes — paiement
router.patch('/orders/:id/payment', requirePermission('orders.markPaid'), updateOrderPayment);

module.exports = router;
