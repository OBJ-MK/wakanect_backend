const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

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

    // Image (Supabase Storage URL)
    imageUrl: { type: String },

    // Catégorie libre
    category: { type: String, trim: true },

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
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// Index composé pour garantir l'unicité SKU par commerçant
productSchema.index({ merchantId: 1, sku: 1 }, { unique: true, sparse: true });
// Index pour le catalogue public
productSchema.index({ merchantId: 1, isPublished: 1 });

// Virtual : stock bas ?
productSchema.virtual('isLowStock').get(function () {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});

productSchema.virtual('isOutOfStock').get(function () {
  return this.stock === 0;
});

module.exports = mongoose.model('Product', productSchema);
