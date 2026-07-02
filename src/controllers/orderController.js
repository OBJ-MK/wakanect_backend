'use strict';

const mongoose      = require('mongoose');
const Order         = require('../models/Order');
const Product       = require('../models/Product');
const Merchant      = require('../models/Merchant');
const ParsedMessage = require('../models/ParsedMessage');
const { notifyNewOrder }  = require('../services/notificationService');
const { actorFromReq }    = require('../utils/actorResolver');
const { toOrderDTO, statusToEn, paymentToEn } = require('../utils/dto');
const { getPlanLimits }   = require('../services/subscriptionService');

// Transitions valides (valeurs internes EN)
const VALID_TRANSITIONS = {
  pending:   ['confirmed', 'cancelled'],
  confirmed: ['delivered', 'cancelled'],
};

/**
 * POST /api/orders/public
 * Création commande depuis le catalogue public (client final, sans auth).
 * Stock NON décrémenté ici — uniquement à la confirmation.
 */
const createOrder = async (req, res) => {
  try {
    const { slug, customer, items } = req.body;

    if (!slug || !customer?.name || !items?.length) {
      return res.status(400).json({ error: 'Champs requis : slug, customer.name, items' });
    }

    const merchant = await Merchant.findOne({ slug, isActive: true });
    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: `Ligne invalide : ${JSON.stringify(item)}` });
      }
    }

    const requestedIds = items.map((i) => i.productId);
    const products     = await Product.find({
      _id: { $in: requestedIds },
      merchantId: merchant._id,
      isPublished: true,
    });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const orderItems  = [];
    let   totalAmount = 0;

    for (const item of items) {
      const product = productMap.get(item.productId.toString());
      if (!product) {
        return res.status(404).json({ error: `Produit ${item.productId} introuvable ou non disponible` });
      }
      const subtotal = product.price * item.quantity;
      orderItems.push({
        productId:   product._id,
        productName: product.name,
        color:       typeof item.color === 'string' && item.color.trim() ? item.color.trim() : undefined,
        quantity:    item.quantity,
        unitPrice:   product.price,
        currency:    product.currency,
        subtotal,
      });
      totalAmount += subtotal;
    }

    const order = await Order.create({
      merchantId: merchant._id,
      customer,
      items:        orderItems,
      totalAmount,
      currency:     'FCFA',
      status:       'pending',
      paymentStatus: 'unpaid',
      statusHistory: [{ status: 'pending', at: new Date() }],
    });

    notifyNewOrder(order).catch((err) =>
      console.error('[notif] Erreur notification nouvelle commande:', err.message)
    );

    res.status(201).json({
      success: true,
      order: {
        orderNumber:      order.orderNumber,
        totalAmount:      order.totalAmount,
        currency:         order.currency,
        status:           order.status,
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
 * Filtre optionnel : status (FR ou EN), paymentStatus (FR ou EN).
 */
const getOrders = async (req, res) => {
  try {
    const { status, paymentStatus, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.merchantId };

    // Accepte FR ou EN pour le filtre
    if (status)        filter.status        = statusToEn(status);
    if (paymentStatus) filter.paymentStatus = paymentToEn(paymentStatus);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(filter),
    ]);

    const parsedPage  = parseInt(page);
    const parsedLimit = parseInt(limit);
    res.json({
      orders:  orders.map(toOrderDTO),
      total,
      page:    parsedPage,
      limit:   parsedLimit,
      hasMore: parsedPage * parsedLimit < total,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * GET /api/orders/:id
 */
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      merchantId: req.merchantId,
    }).lean();

    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    res.json(toOrderDTO(order));
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * PATCH /api/orders/:id/status
 * Accepte le statut en FR ou EN.
 * pending → confirmed : décrémentation atomique du stock (transaction).
 * confirmed → cancelled : ré-incrémentation.
 */
const updateOrderStatus = async (req, res) => {
  try {
    const rawStatus    = req.body.status;
    if (!rawStatus) return res.status(400).json({ error: 'Champ requis : status' });

    const status = statusToEn(rawStatus); // "Confirmée" → "confirmed"

    const order = await Order.findOne({ _id: req.params.id, merchantId: req.merchantId });
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const previousStatus = order.status;
    const allowed        = VALID_TRANSITIONS[previousStatus] || [];

    if (!allowed.includes(status)) {
      const hint = allowed.length
        ? `Transitions autorisées depuis "${previousStatus}" : ${allowed.join(', ')}`
        : `Le statut "${previousStatus}" est terminal, aucune transition possible`;
      return res.status(400).json({ error: `Transition invalide : ${previousStatus} → ${status}. ${hint}` });
    }

    // pending → confirmed : décrémentation atomique
    if (status === 'confirmed') {
      const session    = await mongoose.startSession();
      let   stockError = null;
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
        if (stockError) return res.status(409).json({ error: stockError });
        throw err;
      } finally {
        await session.endSession();
      }
    }

    // confirmed → cancelled : ré-incrémenter le stock en une seule passe (bulkWrite)
    if (status === 'cancelled' && previousStatus === 'confirmed' && order.items.length > 0) {
      await Product.bulkWrite(
        order.items.map(item => ({
          updateOne: {
            filter: { _id: item.productId },
            update: { $inc: { stock: item.quantity } },
          },
        }))
      );
    }

    order.status = status;
    order.statusHistory.push({ status, performedBy: actorFromReq(req), at: new Date() });
    await order.save();

    res.json({ success: true, order: toOrderDTO(order) });
  } catch (err) {
    console.error('[updateOrderStatus]', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/orders/:id/payment
 * Body : { payment_status: "Payée" }  (FR) ou { paymentStatus: "paid" } (EN legacy)
 */
const updateOrderPayment = async (req, res) => {
  try {
    const rawStatus = req.body.payment_status || req.body.paymentStatus;
    const internalStatus = paymentToEn(rawStatus); // "Payée" → "paid"

    const validStatuses = ['unpaid', 'partial', 'paid'];
    if (!internalStatus || !validStatuses.includes(internalStatus)) {
      return res.status(400).json({
        error: `payment_status invalide. Valeurs acceptées : Payée, Partiel, En attente de paiement`,
      });
    }

    const order = await Order.findOne({ _id: req.params.id, merchantId: req.merchantId });
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    order.paymentStatus = internalStatus;
    if (req.body.paymentMethod) order.paymentMethod = req.body.paymentMethod;
    order.statusHistory.push({
      status:      `payment:${internalStatus}`,
      performedBy: actorFromReq(req),
      at:          new Date(),
    });
    await order.save();

    res.json({ success: true, order: toOrderDTO(order) });
  } catch (err) {
    console.error('[updateOrderPayment]', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/stats
 * Shape exacte du contrat : { revenue_today, revenue_change, pending_validation,
 *                             orders_count, low_stock_count }
 */
const getDashboardStats = async (req, res) => {
  try {
    const planLimits = await getPlanLimits(req.merchantId);
    if (!planLimits.features.advanced_stats) {
      return res.status(403).json({
        code:    'FEATURE_NOT_AVAILABLE',
        message: 'Advanced analytics requires Pro plan or higher',
      });
    }

    const merchantId = req.merchantId;
    const MID        = new mongoose.Types.ObjectId(merchantId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const endOfYesterday = new Date(startOfToday);
    endOfYesterday.setTime(endOfYesterday.getTime() - 1);

    const [
      revenueTodayAgg,
      revenueYesterdayAgg,
      pendingValidation,
      ordersCount,
      lowStockCount,
    ] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            merchantId: MID,
            status:     { $in: ['confirmed', 'delivered'] },
            createdAt:  { $gte: startOfToday },
          },
        },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      Order.aggregate([
        {
          $match: {
            merchantId: MID,
            status:     { $in: ['confirmed', 'delivered'] },
            createdAt:  { $gte: startOfYesterday, $lt: startOfToday },
          },
        },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      ParsedMessage.countDocuments({ merchantId, status: 'pending_review' }),
      Order.countDocuments({ merchantId, status: { $nin: ['cancelled'] } }),
      Product.countDocuments({
        merchantId,
        $expr: { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] },
      }),
    ]);

    const revenueToday     = revenueTodayAgg[0]?.total     || 0;
    const revenueYesterday = revenueYesterdayAgg[0]?.total || 0;
    const revenueChange    = revenueYesterday > 0
      ? Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 100)
      : 0;

    res.json({
      revenue_today:      revenueToday,
      revenue_change:     revenueChange,
      pending_validation: pendingValidation,
      orders_count:       ordersCount,
      low_stock_count:    lowStockCount,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updateOrderPayment,
  getDashboardStats,
};
