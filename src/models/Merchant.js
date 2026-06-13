const mongoose = require('mongoose');

const merchantSchema = new mongoose.Schema(
  {
    // Identité
    businessName: {
      type: String,
      required: [true, 'Le nom de la boutique est requis'],
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'Le slug ne peut contenir que des lettres, chiffres et tirets'],
    },
    ownerName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    // WhatsApp
    whatsappPhone: {
      type: String,
      required: [true, 'Le numéro WhatsApp est requis'],
      unique: true,
    },
    whatsappPhoneId: {
      // Phone Number ID fourni par Meta
      type: String,
      unique: true,
      sparse: true,
    },

    // Statut
    isActive: { type: Boolean, default: true },
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro'],
      default: 'free',
    },

    // Auth
    passwordHash: { type: String },

    // Employés (sous-documents embarqués)
    employees: [
      {
        name: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },
        passwordHash: { type: String, required: true },
        active: { type: Boolean, default: true },
        permissions: { type: [String], default: [] },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Catalogue
    catalogDescription: { type: String, trim: true },
    logoUrl: { type: String },

    // Compteur de scans mensuel (soft-limit — enforcement dans le module abonnement)
    usage: {
      scansCurrentMonth: { type: Number, default: 0 },
      scansMonth: { type: String, default: '' }, // "YYYY-MM"
    },

    // Dernière réception d'un message WhatsApp entrant — fenêtre 24h notifications
    lastInboundAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// Index for multi-number routing: both owner and employee phones must be fast to query
merchantSchema.index({ 'employees.phone': 1 });

// URL publique de la boutique
merchantSchema.virtual('storeUrl').get(function () {
  return `${process.env.APP_URL}/boutique/${this.slug}`;
});

module.exports = mongoose.model('Merchant', merchantSchema);
