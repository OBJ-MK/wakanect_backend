'use strict';

const mongoose = require('mongoose');

/**
 * Réglages admin — une doc par clé (key='pilot' pour les dates du pilote,
 * d'autres clés pourront s'ajouter plus tard sans migration de schéma).
 * Consommé par settingsController.js et adminStatsService.js#parseDateRange.
 */
const adminSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    pilotStartDate: { type: Date, default: null },
    pilotEndDate: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);