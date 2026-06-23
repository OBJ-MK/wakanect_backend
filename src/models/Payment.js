'use strict';

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    plan:    { type: String, enum: ['pro', 'premium'], required: true },
    period:  { type: String, enum: ['monthly', 'quarterly', 'semiannual', 'annual'], required: true },
    country: { type: String, enum: ['SN', 'ML'], required: true },
    amount:  { type: Number, required: true },
    currency: { type: String, default: 'XOF' },

    // Clé d'idempotence — posée après l'appel createCheckoutInvoice
    paydunyaInvoiceToken: {
      type: String,
      unique: true,
      sparse: true,
    },

    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },

    paidAt: { type: Date },

    // Snapshot brut de la réponse /checkout-invoice/confirm (audit)
    rawConfirm: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
