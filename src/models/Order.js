const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productName: { type: String, required: true }, // snapshot au moment de la commande
    color: { type: String, trim: true }, // variante couleur choisie par le client (optionnel)
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    currency: { type: String, default: 'FCFA' },
    subtotal: { type: Number, required: true },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    // Numéro lisible : ORD-2024-0001
    orderNumber: { type: String, unique: true },

    // Client
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, trim: true },
      address: { type: String, trim: true },
      notes: { type: String, trim: true },
    },

    // Produits commandés
    items: [orderItemSchema],

    // Totaux
    totalAmount: { type: Number, required: true },
    currency: { type: String, default: 'FCFA' },

    // Statut
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
      default: 'pending',
      index: true,
    },

    // Paiement
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'partial', 'paid'],
      default: 'unpaid',
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'wave', 'orange_money', 'free_money', 'proof', 'other'],
    },

    // Preuve de paiement téléversée par le client ("J'ai déjà payé")
    paymentProof: {
      url:        { type: String },
      r2Key:      { type: String },
      uploadedAt: { type: Date },
    },

    // Notification WhatsApp envoyée au commerçant ?
    merchantNotified: { type: Boolean, default: false },
    merchantNotifiedAt: { type: Date },

    // Status change audit trail — one entry per transition
    statusHistory: [
      {
        status: { type: String, required: true },
        performedBy: { type: performedBySchema },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

// Index composés pour les requêtes filtrées + triées de la page Commandes
orderSchema.index({ merchantId: 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, status: 1, createdAt: -1 });

// Génération automatique du numéro de commande
orderSchema.pre('save', async function () {
  if (this.isNew && !this.orderNumber) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments({
      merchantId: this.merchantId,
      createdAt: { $gte: new Date(`${year}-01-01`) },
    });
    this.orderNumber = `ORD-${year}-${String(count + 1).padStart(4, '0')}`;
  }
});

module.exports = mongoose.model('Order', orderSchema);
