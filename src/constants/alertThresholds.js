'use strict';

/**
 * Seuils d'alerte pour le back-office admin.
 * Toutes les valeurs sont lues depuis process.env avec des défauts raisonnables.
 * Ajustables après la phase pilote sans redéploiement.
 */
const THRESHOLDS = {
  // Appels Haiku par boutique par jour → danger
  haikuCallsPerShopDay: parseInt(process.env.ALERT_HAIKU_CALLS_PER_SHOP_DAY, 10) || 100,

  // % d'escalade vers Haiku sur les 24 dernières heures → warning
  haikuEscalationPct24h: parseFloat(process.env.ALERT_HAIKU_ESCALATION_PCT_24H) || 45,

  // Budget Haiku journalier en FCFA → danger si dépassé
  haikuDailyBudgetFcfa: parseFloat(process.env.ALERT_HAIKU_DAILY_BUDGET_FCFA) || 1_000,

  // Taux de conversion USD → FCFA (pour afficher les coûts en FCFA)
  usdToFcfa: parseFloat(process.env.USD_TO_FCFA_RATE) || 600,

  // Essai expirant dans N jours → alerte
  trialExpiryWarningDays: 3,
  trialExpiryDangerDays:  1,
};

module.exports = THRESHOLDS;
