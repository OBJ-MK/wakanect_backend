const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Merchant = require('../models/Merchant');
const { notifyNewOrder } = require('../services/notificationService');
const { actorFromReq } = require('../utils/actorResolver');

// Transitions valides : statuts terminaux (delivered, cancelled) absents → bloqués
const VALID_TRANSITIONS = {
  pending:   ['confirmed', 'cancelled'],
  confirmed: ['delivered', 'cancelled'],
};

/**
 * POST /api/orders/public
 * Création d'une commande depuis le catalogue public (client final, sans auth).
 * Stock NON décrémenté ici — décrémentation uniquement à la confirmation.
 */
const createOrder = async (req, res) => {
  try {
    const { slug, customer, items } = req.body;

    if (!slug || !customer?.name || !items?.length) {
      return res.status(400).json({ error: 'Champs requis : slug, customer.name, items' });
    }

    const merchant = await Merchant.findOne({ slug, isActive: true });
    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    // Enrichir chaque ligne — snapshot produit, pas de touche au stock
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

    const order = await Order.create({
      merchantId: merchant._id,
      customer,
      items: orderItems,
      totalAmount,
      currency: 'FCFA',
      status: 'pending',
      paymentStatus: 'unpaid',
      statusHistory: [{ status: 'pending', at: new Date() }],
    });

    // Notifications non-bloquantes (Web Push + WhatsApp 24h si applicable)
    notifyNewOrder(order).catch((err) =>
      console.error('[notif] Erreur notification nouvelle commande:', err.message)
    );

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
    console.error('[createOrder]', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la commande' });
  }
};

/**
 * GET /api/orders
 * Liste les commandes du commerçant (dashboard), filtrable par statut.
 */
const getOrders = async (req, res) => {
  try {
    const { status, paymentStatus, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.merchantId };
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

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
 * Transitions valides uniquement :
 *   pending → confirmed  (décrémentation atomique du stock, transaction MongoDB)
 *   confirmed → delivered
 *   pending|confirmed → cancelled  (ré-incrémentation si était confirmed)
 */
const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Champ requis : status' });
    }

    const order = await Order.findOne({ _id: req.params.id, merchantId: req.merchantId });
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const previousStatus = order.status;
    const allowed = VALID_TRANSITIONS[previousStatus] || [];

    if (!allowed.includes(status)) {
      const hint = allowed.length
        ? `Transitions autorisées depuis "${previousStatus}" : ${allowed.join(', ')}`
        : `Le statut "${previousStatus}" est terminal, aucune transition possible`;
      return res.status(400).json({ error: `Transition invalide : ${previousStatus} → ${status}. ${hint}` });
    }

    // pending → confirmed : décrémentation atomique avec transaction
    if (status === 'confirmed') {
      const session = await mongoose.startSession();
      let stockError = null;

      try {
        await session.withTransaction(async () => {
          for (const item of order.items) {
            const updated = await Product.findOneAndUpdate(
              { _id: item.productId, stock: { $gte: item.quantity } },
              { $inc: { stock: -item.quantity } },
              { session }
            );
            if (!updated) {
              stockError = `Stock insuffisant pour "${item.productName}"`;
              throw new Error(stockError);
            }
          }
        });
      } catch (err) {
        if (stockError) {
          return res.status(409).json({ error: stockError });
        }
        throw err;
      } finally {
        await session.endSession();
      }
    }

    // confirmed → cancelled : ré-incrémenter le stock
    if (status === 'cancelled' && previousStatus === 'confirmed') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.productId, {
          $inc: { stock: item.quantity },
        });
      }
    }

    order.status = status;
    order.statusHistory.push({ status, performedBy: actorFromReq(req), at: new Date() });
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    console.error('[updateOrderStatus]', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/orders/:id/payment
 * Bascule manuellement le paymentStatus (paid / unpaid).
 * N'affecte pas le statut de commande.
 */
const updateOrderPayment = async (req, res) => {
  try {
    const { paymentStatus, paymentMethod } = req.body;

    const validPaymentStatuses = ['unpaid', 'partial', 'paid'];
    if (!paymentStatus || !validPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({
        error: `paymentStatus invalide. Valeurs : ${validPaymentStatuses.join(', ')}`,
      });
    }

    const order = await Order.findOne({ _id: req.params.id, merchantId: req.merchantId });
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    order.paymentStatus = paymentStatus;
    if (paymentMethod) order.paymentMethod = paymentMethod;
    order.statusHistory.push({
      status: `payment:${paymentStatus}`,
      performedBy: actorFromReq(req),
      at: new Date(),
    });
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    console.error('[updateOrderPayment]', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/stats
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
        { $match: { merchantId: new mongoose.Types.ObjectId(merchantId), status: { $ne: 'cancelled' } } },
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

module.exports = { createOrder, getOrders, updateOrderStatus, updateOrderPayment, getDashboardStats };
