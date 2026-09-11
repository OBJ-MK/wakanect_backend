'use strict';

const mongoose = require('mongoose');

/**
 * Instrumentation de la cascade de parsing.
 * Un document est écrit pour chaque message texte traité (hors 'skipped').
 * Ne stocke pas le message brut — messageLength + lien vers ParsedMessage suffisent.
 */
const parsingEventSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    boutiqueSlug: { type: String, required: true, index: true },

    // Tier qui a produit le résultat final
    tierResolved: {
      type: String,
      enum: ['regex', 'cloudflare', 'deepseek_correction', 'deepseek_full', 'haiku', 'failed', 'quota_exceeded'],
      required: true,
      index: true,
    },

    // Suivi par tier
    regexAttempted: { type: Boolean, default: false },
    regexSuccess: { type: Boolean, default: false },
    cloudflareAttempted: { type: Boolean, default: false },
    cloudflareSuccess: { type: Boolean, default: false },
    deepseekAttempted: { type: Boolean, default: false },
    deepseekPath: { type: String, enum: ['correction', 'full', null], default: null },
    haikuAttempted: { type: Boolean, default: false },

    // Tokens Haiku (0 si non appelé)
    haikuInputTokens: { type: Number, default: 0 },
    haikuOutputTokens: { type: Number, default: 0 },
    haikuCachedTokens: { type: Number, default: 0 },

    // Tokens DeepSeek (0 si non appelé)
    deepseekInputTokens: { type: Number, default: 0 },
    deepseekOutputTokens: { type: Number, default: 0 },
    deepseekCachedTokens: { type: Number, default: 0 },

    // Diagnostic de la décision sur le nom — voir services/parsing/nameValidation.js
    nameDecisionPath: { type: String, default: null },
    nameDecisionReason: { type: String, default: null },

    // Coût USD cumulé (Haiku et/ou DeepSeek selon le chemin emprunté)
    costUsd: { type: Number, default: 0 },

    confidenceScore: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },

    producedValidProduct: { type: Boolean, default: false },
    messageLength: { type: Number, default: 0 },

    // Renseigné en cas d'erreur d'un tier
    errorType: { type: String, default: null },

    // Lien optionnel vers le ParsedMessage produit
    parsedMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ParsedMessage',
      default: null,
    },
  },
  { timestamps: true }
);

// Index pour les agrégations admin (by date, by shop, by tier)
parsingEventSchema.index({ createdAt: -1 });
parsingEventSchema.index({ merchantId: 1, createdAt: -1 });
parsingEventSchema.index({ tierResolved: 1, createdAt: -1 });
parsingEventSchema.index({ haikuAttempted: 1, createdAt: -1 });
parsingEventSchema.index({ deepseekAttempted: 1, createdAt: -1 });

module.exports = mongoose.model('ParsingEvent', parsingEventSchema);
