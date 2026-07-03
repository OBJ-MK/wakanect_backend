const mongoose = require('mongoose');
const performedBySchema = require('../utils/performedBySchema');

/**
 * PendingMedia — zone "à rattacher" pour les images WhatsApp AMBIGUËS.
 *
 * Quand une image sans caption arrive alors que ≥2 candidats pending_review
 * du même expéditeur existent dans la fenêtre d'association, on ne devine
 * JAMAIS le bon candidat : l'image est stockée ici, liée au marchand et à
 * l'expéditeur mais à AUCUN candidat. Le marchand tranche depuis la page de
 * validation (attachement manuel), qui déplace l'image vers le candidat choisi
 * et supprime ce document.
 *
 * Mêmes champs image que imageSchema de ParsedMessage (aplatis) — le document
 * EST l'image, prête à être poussée telle quelle dans candidate.images.
 */

const pendingMediaSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    senderPhone: { type: String },

    // ── Champs image (miroir de imageSchema, ParsedMessage) ──────────────────
    url: { type: String, required: true },
    r2Key: { type: String, required: true },
    mediaId: { type: String, required: true }, // WhatsApp media ID — idempotence
    mimeType: { type: String, default: 'image/webp' },
    originalMimeType: { type: String },
    width: { type: Number },
    height: { type: Number },
    submittedBy: { type: performedBySchema, default: undefined },
    receivedAt: { type: Date, default: Date.now },
    // Timestamp WhatsApp du message image (payload Meta)
    waTimestamp: { type: Date },
    sha256: { type: String },
    phash: { type: String },
  },
  { timestamps: true }
);

// Idempotence : un même mediaId ne crée qu'une seule image orpheline par boutique
// (le webhook Meta peut rejouer le même message).
pendingMediaSchema.index({ merchantId: 1, mediaId: 1 }, { unique: true });

module.exports = mongoose.model('PendingMedia', pendingMediaSchema);
