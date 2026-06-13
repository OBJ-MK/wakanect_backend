const Order = require('../models/Order');
const Product = require('../models/Product');
const Merchant = require('../models/Merchant');
const { notifyMerchantNewOrder } = require('../services/whatsappService');
const { actorFromReq } = require('../utils/actorResolver');

/**
 * POST /api/orders
 * Création d'une commande depuis le catalogue public (client final)
 * Body: { slug, customer: { name, phone, address, notes }, items: [{ productId, quantity }] }
 */
const createOrder = async (req, res) => {
  try {
    const { slug, customer, items } = req.body;

    if (!slug || !customer?.name || !items?.length) {
      return res.status(400).json({ error: 'Champs requis : slug, customer.name, items' });
    }

    // Trouver le commerçant
    const merchant = await Merchant.findOne({ slug, isActive: true });
    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    // Valider et enrichir chaque ligne de commande
    const orderItems = [];
    let totalAmount = 0;

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: `Ligne invalide : ${JSON.stringify(item)}` });
      }

      const product = await Product.findOne({
        _id: item.productId,
        merchantId: merchant._id,
        isPublished: true,
      });

      if (!product) {
        return res.status(404).json({ error: `Produit ${item.productId} introuvable ou non disponible` });
      }

      if (product.stock < item.quantity) {
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}" (disponible: ${product.stock} ${product.unit})`,
        });
      }

      const subtotal = product.price * item.quantity;
      orderItems.push({
        productId: product._id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice: product.price,
        currency: product.currency,
        subtotal,
      });
      totalAmount += subtotal;
    }

    // Créer la commande
    const order = await Order.create({
      merchantId: merchant._id,
      customer,
      items: orderItems,
      totalAmount,
      currency: 'FCFA',
    });

    // Déduire le stock immédiatement (optimiste)
    for (const item of orderItems) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { stock: -item.quantity },
      });
    }

    // Notifier le commerçant via WhatsApp (non-bloquant)
    notifyMerchantNewOrder(merchant, order)
      .then((result) => {
        if (result.success) {
          Order.findByIdAndUpdate(order._id, {
            merchantNotified: true,
            merchantNotifiedAt: new Date(),
          }).exec();
        }
      })
      .catch((err) => console.error(' Notification WhatsApp échouée:', err.message));

    res.status(201).json({
      success: true,
      order: {
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        currency: order.currency,
        status: order.status,
        merchantWhatsapp: merchant.whatsappPhone,
      },
    });
  } catch (err) {
    console.error(' createOrder:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la commande' });
  }
};

/**
 * GET /api/orders
 * Liste les commandes du commerçant (dashboard)
 */
const getOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.merchantId };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ orders, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * PATCH /api/orders/:id/status
 * Mise à jour du statut d'une commande
 */
const updateOrderStatus = async (req, res) => {
  try {
    const { status, paymentStatus, paymentMethod } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Statut invalide. Valeurs : ${validStatuses.join(', ')}` });
    }

    const updates = {};
    if (status) updates.status = status;
    if (paymentStatus) updates.paymentStatus = paymentStatus;
    if (paymentMethod) updates.paymentMethod = paymentMethod;

    // Append a status history entry when status changes
    const historyPush = status
      ? {
          $push: {
            statusHistory: {
              status,
              performedBy: actorFromReq(req),
              at: new Date(),
            },
          },
        }
      : {};

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.merchantId },
      { $set: updates, ...historyPush },
      { new: true }
    );

    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    // Si annulation → re-créditer le stock
    if (status === 'cancelled') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.productId, {
          $inc: { stock: item.quantity },
        });
      }
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/stats
 * Statistiques rapides pour le dashboard
 */
const getDashboardStats = async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalProducts,
      publishedProducts,
      lowStockCount,
      outOfStockCount,
      pendingOrders,
      todayOrders,
      totalRevenue,
    ] = await Promise.all([
      Product.countDocuments({ merchantId }),
      Product.countDocuments({ merchantId, isPublished: true }),
      Product.countDocuments({
        merchantId,
        $expr: { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] },
      }),
      Product.countDocuments({ merchantId, stock: 0 }),
      Order.countDocuments({ merchantId, status: 'pending' }),
      Order.countDocuments({ merchantId, createdAt: { $gte: today } }),
      Order.aggregate([
        { $match: { merchantId, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
    ]);

    res.json({
      stock: { total: totalProducts, published: publishedProducts, lowStock: lowStockCount, outOfStock: outOfStockCount },
      orders: { pending: pendingOrders, today: todayOrders },
      revenue: { total: totalRevenue[0]?.total || 0, currency: 'FCFA' },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, getDashboardStats };
