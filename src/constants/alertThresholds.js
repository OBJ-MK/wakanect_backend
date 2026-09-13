'use strict';

/**
 * Seuils d'alerte pour le back-office admin.
 * Toutes les valeurs sont lues depuis process.env avec des défauts raisonnables.
 * Ajustables après la phase pilote sans redéploiement.
 */
const THRESHOLDS = {
  // Appels DeepSeek par boutique par jour → danger (DeepSeek = seule IA de
  // parsing réellement payante en production ; Haiku n'est qu'un filet de
  // secours quasi jamais sollicité, cf. parserService.js tier 4).
  deepseekCallsPerShopDay: parseInt(process.env.ALERT_DEEPSEEK_CALLS_PER_SHOP_DAY, 10) || 100,

  // % d'escalade vers DeepSeek sur les 24 dernières heures → warning
  deepseekEscalationPct24h: parseFloat(process.env.ALERT_DEEPSEEK_ESCALATION_PCT_24H) || 45,

  // Budget DeepSeek journalier en FCFA → danger si dépassé
  deepseekDailyBudgetFcfa: parseFloat(process.env.ALERT_DEEPSEEK_DAILY_BUDGET_FCFA) || 1_000,

  // Taux de conversion USD → FCFA (pour afficher les coûts en FCFA)
  usdToFcfa: parseFloat(process.env.USD_TO_FCFA_RATE) || 600,

  // Essai expirant dans N jours → alerte
  trialExpiryWarningDays: 3,
  trialExpiryDangerDays:  1,
};

module.exports = THRESHOLDS;