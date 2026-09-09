'use strict';

const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
  merchantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Merchant',
    required: true,
    index: true,
  },
  eventType: {
    type: String,
    enum: ['page_view', 'product_view', 'add_to_cart', 'checkout_started', 'order_placed'],
    required: true,
  },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, // product_view / add_to_cart
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },   // order_placed
  sessionId: { type: String }, // identifiant client léger (sessionStorage), pas de compte

  // TTL 90 jours — purge automatique, pas de script de nettoyage à maintenir
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
});

analyticsEventSchema.index({ merchantId: 1, eventType: 1, createdAt: -1 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);