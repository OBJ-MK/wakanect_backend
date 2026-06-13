'use strict';

const mongoose = require('mongoose');

/**
 * Journal d'audit cross-tenant.
 * Toute action sensible (admin ou owner/employé) y est tracée.
 */
const auditLogSchema = new mongoose.Schema(
  {
    // Auteur de l'action
    authorType: {
      type: String,
      enum: ['admin', 'owner', 'employee'],
      required: true,
      index: true,
    },
    authorId:   { type: String, default: null },
    authorName: { type: String, default: null },
    // Pour les employés : numéro de téléphone comme identité principale
    authorPhone: { type: String, default: null },

    // Action effectuée (ex: 'suspend', 'impersonate', 'change-plan', 'reset-password', 'extend-trial')
    action: { type: String, required: true, index: true },

    // Cible de l'action (ID du document affecté)
    target: { type: String, default: null },

    // Boutique concernée (pour le cross-tenant)
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      default: null,
      index: true,
    },
    slug: { type: String, default: null },

    // Données libres (before/after, raison, etc.)
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
