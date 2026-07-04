'use strict';

const mongoose      = require('mongoose');
const Order         = require('../models/Order');
const Product       = require('../models/Product');
const Merchant      = require('../models/Merchant');
const ParsedMessage = require('../models/ParsedMessage');
const { notifyNewOrder }  = require('../services/notificationService');
const { actorFromReq }    = require('../utils/actorResolver');
const { toOrderDTO, statusToEn, paymentToEn } = require('../utils/dto');
const { compressImage, uploadToR2 } = require('../services/mediaService');

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
const PUBLIC_PAYMENT_METHODS = new Set(['wave', 'orange_money', 'free_money', 'cash', 'proof']);

const createOrder = async (req, res) => {
  try {
    const { slug, customer, items, paymentMethod } = req.body;

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
      ...(PUBLIC_PAYMENT_METHODS.has(paymentMethod) ? { paymentMethod } : {}),
      statusHistory: [{ status: 'pending', at: new Date() }],
    });

    notifyNewOrder(order).catch((err) =>
      console.error('[notif] Erreur notification nouvelle commande:', err.message)
    );

    res.status(201).json({
      success: true,
      order: {
        id:               order._id.toString(),
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
 * POST /api/orders/public/:id/proof   (multipart, champ "image")
 * Le client "J'ai déjà payé" téléverse sa capture de paiement juste après
 * la création de la commande. Fenêtre de 48h, une seule preuve par commande.
 */
const uploadPaymentProof = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'Image requise (champ "image")' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    if (order.paymentProof?.r2Key) {
      return res.status(409).json({ error: 'Une preuve a déjà été envoyée pour cette commande' });
    }
    if (Date.now() - order.createdAt.getTime() > 48 * 60 * 60 * 1000) {
      return res.status(410).json({ error: 'Délai dépassé — contactez la boutique directement' });
    }

    const { buffer } = await compressImage(req.file.buffer);
    const { url, r2Key } = await uploadToR2(buffer, {
      merchantId: order.merchantId.toString(),
      folder: `merchants/${order.merchantId}/payment-proofs/${order._id}`,
    });

    order.paymentProof = { url, r2Key, uploadedAt: new Date() };
    order.statusHistory.push({ status: 'payment:proof_submitted', at: new Date() });
    await order.save();

    res.json({ success: true, proof_url: url });
  } catch (err) {
    console.error('[uploadPaymentProof]', err.message);
    res.status(500).json({ error: "Erreur lors de l'envoi de la preuve" });
  }
};

/**
 * GET /api/orders
 * Filtre optionnel : status (FR ou EN), paymentStatus (FR ou EN).
 */
const getOrders = async (req, res) => {
  try {
    const { status, paymentStatus, search, sort, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.merchantId };

    // Accepte FR ou EN pour le filtre
    if (status)        filter.status        = statusToEn(status);
    if (paymentStatus) filter.paymentStatus = paymentToEn(paymentStatus);
    if (search)        filter['customer.name'] = { $regex: search, $options: 'i' };

    // Tri : recent (défaut) | price_asc | price_desc (sur le total)
    const SORT_MAP = {
      recent:     { createdAt: -1 },
      price_asc:  { totalAmount: 1 },
      price_desc: { totalAmount: -1 },
    };

    const parsedPage  = Math.max(1, parseInt(page)  || 1);
    const parsedLimit = Math.min(50, parseInt(limit) || 20);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort(SORT_MAP[sort] || { createdAt: -1 })
        .skip((parsedPage - 1) * parsedLimit)
        .limit(parsedLimit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    const items = orders.map(toOrderDTO);
    res.json({
      items,
      orders:  items, // alias legacy — clients déployés avant la pagination numérotée
      total,
      page:    parsedPage,
      pages:   Math.max(1, Math.ceil(total / parsedLimit)),
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
 * GET /api/dashboard/stats?period=day|week|month|all   (défaut : day)
 *
 * Stats de base de l'accueil — accessibles à TOUS les plans (le gating
 * advanced_stats ne concerne que la section Analytics avancées côté UI ;
 * le 403 historique ici cassait l'accueil des comptes free/trial).
 *
 * Fenêtres : day = calendaire (depuis minuit) vs hier ;
 *            week/month = 7/30 jours glissants vs fenêtre précédente ;
 *            all = cumul total, pas de comparaison (revenue_change: null).
 *
 * Shape : { period, revenue, revenue_change, revenue_today (compat),
 *           pending_validation, orders_count, low_stock_count }
 */
const PERIOD_DAYS = { week: 7, month: 30 };

const getDashboardStats = async (req, res) => {
  try {
    const period = ['day', 'week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'day';

    const merchantId = req.merchantId;
    const MID        = new mongoose.Types.ObjectId(merchantId);

    let curStart = null, prevStart = null, prevEnd = null;
    if (period === 'day') {
      curStart = new Date();
      curStart.setHours(0, 0, 0, 0);
      prevStart = new Date(curStart);
      prevStart.setDate(prevStart.getDate() - 1);
      prevEnd = curStart;
    } else if (period !== 'all') {
      const ms = PERIOD_DAYS[period] * 24 * 60 * 60 * 1000;
      const now = Date.now();
      curStart  = new Date(now - ms);
      prevStart = new Date(now - 2 * ms);
      prevEnd   = curStart;
    }

    const revenueAgg = (start, end) => Order.aggregate([
      {
        $match: {
          merchantId: MID,
          status:     { $in: ['confirmed', 'delivered'] },
          ...(start ? { createdAt: { $gte: start, ...(end ? { $lt: end } : {}) } } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]);

    const [
      revenueCurAgg,
      revenuePrevAgg,
      pendingValidation,
      ordersCount,
      lowStockCount,
    ] = await Promise.all([
      revenueAgg(curStart, null),
      period === 'all' ? Promise.resolve([]) : revenueAgg(prevStart, prevEnd),
      ParsedMessage.countDocuments({ merchantId, status: 'pending_review' }),
      Order.countDocuments({ merchantId, status: { $nin: ['cancelled'] } }),
      Product.countDocuments({
        merchantId,
        $expr: { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] },
      }),
    ]);

    const revenue     = revenueCurAgg[0]?.total  || 0;
    const revenuePrev = revenuePrevAgg[0]?.total || 0;
    const revenueChange = period !== 'all' && revenuePrev > 0
      ? Math.round(((revenue - revenuePrev) / revenuePrev) * 100)
      : null;

    res.json({
      period,
      revenue,
      revenue_change:     revenueChange,
      revenue_today:      revenue, // compat anciens clients (bundle PWA en cache)
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
  uploadPaymentProof,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updateOrderPayment,
  getDashboardStats,
};
