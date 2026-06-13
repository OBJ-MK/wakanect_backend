'use strict';

/**
 * Grille tarifaire Wakanect (FCFA).
 * Source de vérité unique côté serveur — ne jamais exposer en clair au client commerçant.
 *
 * Structure : GRID[country][plan][period] = montant total en FCFA
 *
 * Remises intégrées dans les montants :
 *   - quarterly  : −10 % vs mensuel × 3
 *   - semiannual : 1 mois offert (5 mois payés pour 6)
 *   - annual     : 2 mois offerts (10 mois payés pour 12)
 */
const GRID = {
  SN: {
    pro: {
      monthly:    5_000,
      quarterly: 13_500,
      semiannual: 25_000,
      annual:     50_000,
    },
    premium: {
      monthly:     9_000,
      quarterly:  24_500,
      semiannual: 45_000,
      annual:     90_000,
    },
  },
  ML: {
    pro: {
      monthly:    3_500,
      quarterly:  9_500,
      semiannual: 17_500,
      annual:     35_000,
    },
    premium: {
      monthly:     6_500,
      quarterly:  17_500,
      semiannual: 32_500,
      annual:     65_000,
    },
  },
};

// Durée en mois de chaque période (pour calcul MRR)
const PERIOD_MONTHS = {
  trial:      0,
  monthly:    1,
  quarterly:  3,
  semiannual: 6,
  annual:     12,
};

/**
 * Retourne le montant total (FCFA) pour un plan/période/pays.
 * Retourne 0 pour le plan 'free' ou période 'trial'.
 */
function getPriceFcfa(country, plan, period) {
  if (plan === 'free' || period === 'trial') return 0;
  return GRID[country]?.[plan]?.[period] ?? 0;
}

/**
 * Déduit le pays depuis le numéro de téléphone normalisé (sans +).
 * Ex: '221776543210' → 'SN', '22376543210' → 'ML'
 */
function detectCountryFromPhone(phone) {
  const p = String(phone || '');
  if (p.startsWith('221')) return 'SN';
  if (p.startsWith('223')) return 'ML';
  return 'SN'; // défaut Sénégal
}

module.exports = { GRID, PERIOD_MONTHS, getPriceFcfa, detectCountryFromPhone };
