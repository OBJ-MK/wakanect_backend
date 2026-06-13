const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

/**
 * ParsedMessage — Écran de validation du parsing
 * 
 * Quand un commerçant envoie un message WhatsApp de mise à jour stock,
 * on stocke le résultat du parsing ICI avant de l'appliquer.
 * Le commerçant valide depuis son dashboard → stock mis à jour.
 */

const parsedItemSchema = new mongoose.Schema(
  {
    // Ce qu'on a extrait du message
    rawText: { type: String },          // texte brut de la ligne
    productName: { type: String },       // nom détecté
    sku: { type: String },               // SKU détecté (optionnel)
    quantity: { type: Number },          // quantité détectée
    price: { type: Number },             // prix détecté (optionnel)
    unit: { type: String },              // unité détectée

    // Correspondance trouvée en base
    matchedProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    matchConfidence: {
      type: String,
      enum: ['exact', 'fuzzy', 'none'],
      default: 'none',
    },

    // Action à effectuer
    action: {
      type: String,
      enum: ['set_stock', 'add_stock', 'update_price', 'new_product'],
      default: 'set_stock',
    },

    // Le commerçant peut corriger avant validation
    correctedProductName: { type: String },
    correctedQuantity: { type: Number },
    correctedPrice: { type: Number },

    // Statut de cette ligne
    lineStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'applied'],
      default: 'pending',
    },
  },
  { _id: false }
);

const parsedMessageSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    // Message original WhatsApp
    waMessageId: { type: String, unique: true, sparse: true },
    rawMessage: { type: String, required: true },
    senderPhone: { type: String },
    receivedAt: { type: Date, default: Date.now },

    // Who sent the WhatsApp message (owner or employee resolved from senderPhone)
    submittedBy: { type: performedBySchema, default: undefined },

    // Résultat du parsing
    parsedItems: [parsedItemSchema],
    parseError: { type: String },       // si le format était invalide

    // Statut global
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'partially_applied', 'applied'],
      default: 'pending_review',
      index: true,
    },

    // Qui a validé et quand
    reviewedBy: { type: String },       // 'merchant' ou 'auto'
    reviewedAt: { type: Date },

    // Résumé post-application
    appliedSummary: {
      productsUpdated: { type: Number, default: 0 },
      productsCreated: { type: Number, default: 0 },
      errors: [String],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ParsedMessage', parsedMessageSchema);
