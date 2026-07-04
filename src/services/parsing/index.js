'use strict';

/**
 * WAKANECT — Couche regex du parser (point d'entrée)
 *
 * Ce dossier contient tout l'algorithme d'extraction sans IA :
 *   lexicon.js    — vocabulaire (couleurs, unités, devises, bruit)
 *   normalize.js  — nettoyage du texte, prix ouest-africains
 *   price.js      — extraction du prix (4 stratégies + repli nombre nu)
 *   quantity.js   — extraction de la quantité (5 stratégies)
 *   attributes.js — tailles & couleurs
 *   structured.js — format historique "STOCK" ligne à ligne
 *   freeform.js   — pipeline forme libre
 */

const { extractStructured } = require('./structured');
const { extractFreeForm } = require('./freeform');
const { normalizeUnit, CURRENCY_PAT } = require('./lexicon');

/**
 * Essaie d'abord le format structuré (`:` + `|`), sinon la forme libre.
 */
function extractWithRegex(text) {
  const t = String(text || '').trim();
  return extractStructured(t) || extractFreeForm(t);
}

// Une ligne "ressemble à un produit autonome" si elle porte un marqueur de prix
const PRICE_MARKER_RE = new RegExp(`\\d\\s*${CURRENCY_PAT}|\\bprix\\b`, 'i');

/**
 * Découpe un message en lignes produits.
 *  - En-tête "STOCK" : chaque ligne suivante est un produit (comportement historique).
 *  - Sinon, si ≥ 2 lignes portent chacune leur propre marqueur de prix
 *    (devise ou "prix"), on découpe : c'est une liste de produits.
 *  - Sinon le message entier est un seul produit.
 */
function splitIntoProductLines(text) {
  const t = String(text || '').trim();

  const headerRE = /^(STOCK|stock|Stock)\s*(\n|$)/m;
  if (headerRE.test(t)) {
    const lines = t.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines : [t];
  }

  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const priced = lines.filter((l) => PRICE_MARKER_RE.test(l));
    if (priced.length >= 2 && priced.length === lines.length) return lines;
  }

  return [t];
}

module.exports = { extractWithRegex, splitIntoProductLines, normalizeUnit };
