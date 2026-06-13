const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

/**
 * ParsedMessage — file d'attente de validation dashboard
 *
 * Chaque document = un message WhatsApp → un produit candidat.
 * Les messages multi-lignes (format STOCK) génèrent un document par ligne.
 */

const parsedItemSchema = new mongoose.Schema(
  {
    rawText: { type: String },
    productName: { type: String },
    sku: { type: String },
    quantity: { type: Number },
    price: { type: Number },
    unit: { type: String },
    matchedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    matchConfidence: { type: String, enum: ['exact', 'fuzzy', 'none'], default: 'none' },
    action: { type: String, enum: ['set_stock', 'add_stock', 'update_price', 'new_product', 'subtract_stock'], default: 'set_stock' },
    correctedProductName: { type: String },
    correctedQuantity: { type: Number },
    correctedPrice: { type: Number },
    lineStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'applied'], default: 'pending' },
  },
  { _id: false }
);

const parsedMessageSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    // Message WhatsApp original
    waMessageId: { type: String, unique: true, sparse: true },
    rawMessage: { type: String, required: true },
    senderPhone: { type: String },
    receivedAt: { type: Date, default: Date.now },

    // Qui a envoyé le message (owner ou employé, résolu depuis senderPhone)
    submittedBy: { type: performedBySchema, default: undefined },

    // ── Résultat du parser en cascade ──────────────────────────────────────────
    // Produit candidat extrait (nouveau format — un produit par ParsedMessage)
    product: {
      name: { type: String },
      price: { type: Number },
      quantity: { type: Number },
      unit: { type: String },
      sizes: [{ type: String }],
      colors: [{ type: String }],
      category: { type: String },
      sku: { type: String },
      action: { type: String, default: 'set_stock' },
    },

    // Méta-données du parsing
    parserTier: {
      type: String,
      enum: ['regex', 'cloudflare', 'haiku', 'skipped'],
      index: true,
    },
    confidence: { type: Number, min: 0, max: 100, index: true },
    needsReview: { type: Boolean, default: true },
    missingCritical: [{ type: String }],

    // Ancien format multi-lignes (backward compat — ne plus utiliser pour les nouveaux messages)
    parsedItems: [parsedItemSchema],
    parseError: { type: String },

    // Statut global
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'partially_applied', 'applied'],
      default: 'pending_review',
      index: true,
    },

    // Validation dashboard
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    appliedSummary: {
      productsUpdated: { type: Number, default: 0 },
      productsCreated: { type: Number, default: 0 },
      errors: [String],
    },
  },
  { timestamps: true }
);

// Tri de la file par confiance croissante (incertains en premier → alertes visibles)
parsedMessageSchema.index({ merchantId: 1, status: 1, confidence: 1 });

module.exports = mongoose.model('ParsedMessage', parsedMessageSchema);
