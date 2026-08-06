'use strict';

/**
 * Pays supportés par Wakanect — SOURCE DE VÉRITÉ UNIQUE.
 * Ajouter un pays ici l'active automatiquement dans :
 * pricing (fallback), détection, modèles Mongo, filtres admin.
 *
 * dialPrefixes : préfixe international SANS le "+", sur numéro déjà normalisé.
 */
const COUNTRIES = {
  // AFRIQUE DE L'OUEST
  BJ: { name: 'Bénin',              dialPrefixes: ['229'], tier: 2 },
  BF: { name: 'Burkina Faso',       dialPrefixes: ['226'], tier: 2 },
  CV: { name: 'Cap-Vert',           dialPrefixes: ['238'], tier: 1 },
  CI: { name: "Côte d'Ivoire",      dialPrefixes: ['225'], tier: 1 },
  GM: { name: 'Gambie',             dialPrefixes: ['220'], tier: 3 },
  GH: { name: 'Ghana',              dialPrefixes: ['233'], tier: 1 },
  GN: { name: 'Guinée',             dialPrefixes: ['224'], tier: 2 },
  GW: { name: 'Guinée-Bissau',      dialPrefixes: ['245'], tier: 3 },
  LR: { name: 'Libéria',            dialPrefixes: ['231'], tier: 3 },
  ML: { name: 'Mali',               dialPrefixes: ['223'], tier: 2 },
  MR: { name: 'Mauritanie',         dialPrefixes: ['222'], tier: 2 },
  NE: { name: 'Niger',              dialPrefixes: ['227'], tier: 3 },
  NG: { name: 'Nigéria',            dialPrefixes: ['234'], tier: 1 },
  SN: { name: 'Sénégal',            dialPrefixes: ['221'], tier: 1 },
  SL: { name: 'Sierra Leone',       dialPrefixes: ['232'], tier: 3 },
  TG: { name: 'Togo',               dialPrefixes: ['228'], tier: 2 },

  // AFRIQUE CENTRALE
  AO: { name: 'Angola',             dialPrefixes: ['244'], tier: 1 },
  BI: { name: 'Burundi',            dialPrefixes: ['257'], tier: 3 },
  CM: { name: 'Cameroun',           dialPrefixes: ['237'], tier: 1 },
  CF: { name: 'Centrafrique',       dialPrefixes: ['236'], tier: 3 },
  CG: { name: 'Congo-Brazzaville',  dialPrefixes: ['242'], tier: 2 },
  CD: { name: 'Congo-Kinshasa (RDC)', dialPrefixes: ['243'], tier: 3 },
  GA: { name: 'Gabon',              dialPrefixes: ['241'], tier: 1 },
  GQ: { name: 'Guinée équatoriale', dialPrefixes: ['240'], tier: 1 },
  RW: { name: 'Rwanda',             dialPrefixes: ['250'], tier: 2 },
  ST: { name: 'Sao Tomé-et-Principe', dialPrefixes: ['239'], tier: 3 },
  TD: { name: 'Tchad',              dialPrefixes: ['235'], tier: 2 },
};

const SUPPORTED_COUNTRY_CODES = Object.keys(COUNTRIES);

function getCountryTier(code) {
  return COUNTRIES[code]?.tier ?? 1;
}

function detectCountryFromPhone(phone) {
  const p = String(phone || '');
  for (const [code, { dialPrefixes }] of Object.entries(COUNTRIES)) {
    if (dialPrefixes.some((prefix) => p.startsWith(prefix))) return code;
  }
  return 'SN';
}

module.exports = { COUNTRIES, SUPPORTED_COUNTRY_CODES, detectCountryFromPhone, getCountryTier };