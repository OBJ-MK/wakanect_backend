const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    r2Key: { type: String, required: true },
    mediaId: { type: String },
    mimeType: { type: String, default: 'image/webp' },
    width: { type: Number },
    height: { type: Number },
    isPrimary: { type: Boolean, default: false },
    submittedBy: { type: performedBySchema, default: undefined },
    receivedAt: { type: Date, default: Date.now },
    // ── Empreintes anti-doublons ────────────────────────────────────────────
    sha256: { type: String },  // hash exact du binaire webp compressé
    phash:  { type: String },  // dHash 64 bits (hex 16 chars) — perceptuel
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    // Isolation multi-tenant — TOUJOURS filtrer par merchant_id
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    // Données produit
    name: {
      type: String,
      required: [true, 'Le nom du produit est requis'],
      trim: true,
    },
    description: { type: String, trim: true },
    price: {
      type: Number,
      required: [true, 'Le prix est requis'],
      min: [0, 'Le prix ne peut pas être négatif'],
    },
    currency: {
      type: String,
      default: 'FCFA',
      uppercase: true,
    },
    unit: {
      // "kg", "pièce", "sachet", "litre"...
      type: String,
      default: 'pièce',
      trim: true,
    },

    // Stock
    stock: {
      type: Number,
      required: true,
      min: [0, 'Le stock ne peut pas être négatif'],
      default: 0,
    },
    lowStockThreshold: {
      type: Number,
      default: 5,
    },

    // Legacy single-image URL (kept for backward compat)
    imageUrl: { type: String },

    // Multi-image support (R2)
    images: { type: [imageSchema], default: [] },

    // Catégorie libre
    category: { type: String, trim: true },

    // Variantes — alimentent ProductDTO.colors / .sizes
    colors: { type: [String], default: [] },
    sizes:  { type: [String], default: [] },

    // Visibilité dans le catalogue public
    isPublished: { type: Boolean, default: false },

    // Who created this product via WhatsApp (copied from ParsedMessage.submittedBy)
    submittedBy: { type: performedBySchema, default: undefined },
    // Who validated/published the product from the dashboard
    publishedBy: { type: performedBySchema, default: undefined },

    // Manual stock edit history
    stockHistory: [
      {
        change: { type: Number, required: true },
        newValue: { type: Number, required: true },
        performedBy: { type: performedBySchema },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],

    // Référence courte pour le parsing WhatsApp
    // Ex: "TOM001", "RIZ-5KG"
    sku: {
      type: String,
      trim: true,
      uppercase: true,
    },

    // ── Résultat de la détection anti-doublons (copié depuis ParsedMessage à l'apply)
    duplicateCheck: {
      isDuplicate: { type: Boolean },
      confidence:  { type: Number, min: 0, max: 1 },
      matchedOn:   { type: String, enum: ['image-exact', 'image-near', 'text+price'] },
      duplicateOf: [{ type: mongoose.Schema.Types.ObjectId }],
      checkedAt:   { type: Date },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// Index composé pour garantir l'unicité SKU par commerçant
productSchema.index(
  { merchantId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } } }
);
// Catalogue public : isPublished + stock couverts d'un coup (évite le scan stock=0)
productSchema.index({ merchantId: 1, isPublished: 1, stock: 1 });
// Catalogue public filtré par catégorie
productSchema.index({ merchantId: 1, isPublished: 1, category: 1, stock: 1 });
// Stock marchand filtré par catégorie + tri name
productSchema.index({ merchantId: 1, category: 1, name: 1 });
// Lookup exact d'empreinte sha256 (O(1)) — scoped par boutique
productSchema.index({ merchantId: 1, 'images.sha256': 1 }, { sparse: true });

// Virtual : stock bas ?
productSchema.virtual('isLowStock').get(function () {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});

productSchema.virtual('isOutOfStock').get(function () {
  return this.stock === 0;
});

module.exports = mongoose.model('Product', productSchema);
