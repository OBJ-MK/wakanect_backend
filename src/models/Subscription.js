'use strict';

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    plan: {
      type: String,
      enum: ['free', 'pro', 'premium'],
      required: true,
    },

    period: {
      type: String,
      enum: ['trial', 'monthly', 'quarterly', 'semiannual', 'annual'],
      required: true,
    },

    // Déduit de l'indicatif téléphonique du commerçant au moment de la création
    country: {
      type: String,
      enum: ['SN', 'ML'],
      required: true,
    },

    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },

    status: {
      type: String,
      enum: ['trial', 'active', 'past_due', 'canceled'],
      default: 'trial',
      index: true,
    },

    // Montant réel facturé (snapshot de la grille au moment de la souscription, en FCFA)
    amountFcfa: { type: Number, default: 0 },

    // Référence transaction PayDunya
    paydunyaRef: { type: String, sparse: true },
  },
  { timestamps: true }
);

subscriptionSchema.index({ merchantId: 1, status: 1 });
subscriptionSchema.index({ endDate: 1, status: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
