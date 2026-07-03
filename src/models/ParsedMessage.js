const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

/**
 * ParsedMessage — file d'attente de validation dashboard
 *
 * Chaque document = un message WhatsApp → un produit candidat.
 * Les messages multi-lignes (format STOCK) génèrent un document par ligne.
 */

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    r2Key: { type: String, required: true },
    mediaId: { type: String },           // WhatsApp media ID — used for dedup
    mimeType: { type: String, default: 'image/webp' },
    originalMimeType: { type: String },
    width: { type: Number },
    height: { type: Number },
    isPrimary: { type: Boolean, default: false },
    submittedBy: { type: performedBySchema, default: undefined },
    receivedAt: { type: Date, default: Date.now },
    // Timestamp WhatsApp du message image (payload Meta) — référence temporelle
    // fiable pour le rattachement par proximité (receivedAt peut dériver).
    waTimestamp: { type: Date },
    // ── Empreintes anti-doublons ────────────────────────────────────────────
    sha256: { type: String },  // hash exact du binaire webp compressé
    phash:  { type: String },  // dHash 64 bits (hex 16 chars) — perceptuel
  },
  { _id: true }
);

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

    // Images attachées (médias WhatsApp → R2)
    images: { type: [imageSchema], default: [] },

    // ── Résultat de la détection anti-doublons ─────────────────────────────────
    // Calculé en asynchrone après attachement des images (ne bloque pas la file).
    // isDuplicate=true → badge affiché, commerçant tranche (rien n'est auto-supprimé).
    duplicateCheck: {
      isDuplicate: { type: Boolean },
      confidence:  { type: Number, min: 0, max: 1 },
      matchedOn:   { type: String, enum: ['image-exact', 'image-near', 'text+price'] },
      duplicateOf: [{ type: mongoose.Schema.Types.ObjectId }], // Product._id ou ParsedMessage._id
      checkedAt:   { type: Date },
    },

    // Statut global
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'partially_applied', 'applied', 'held_quota', 'ignored'],
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
// Lookup exact d'empreinte sha256 (O(1)) — scoped par boutique
parsedMessageSchema.index({ merchantId: 1, 'images.sha256': 1 }, { sparse: true });

module.exports = mongoose.model('ParsedMessage', parsedMessageSchema);
