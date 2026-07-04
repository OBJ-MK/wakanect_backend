'use strict';

/**
 * WAKANECT — Format structuré historique (messages "STOCK")
 *
 *   [SKU] [±] Nom : quantité [unité] [| prix [FCFA]]
 *   ex. "[TOM001] Tomates : 50 kg | 25.000 FCFA"
 */

const { parseWestAfricanPrice } = require('./normalize');
const { normalizeUnit } = require('./lexicon');

const LINE_REGEX =
  /^(?:\[([A-Z0-9_-]+)\]\s*)?([+-])?(.+?)\s*:\s*(\d+(?:[.,]\d+)?)\s*([a-zA-ZÀ-ÿ]+)?\s*(?:\|\s*(\d+(?:[.\s,]\d+)?)\s*(FCFA|XOF|CFA|F)?(?:\/[a-zA-Z]+)?)?$/;

function extractStructured(text) {
  const lineM = text.trim().match(LINE_REGEX);
  if (!lineM) return null;

  const [, sku, sign, rawName, rawQty, rawUnit, rawPrice] = lineM;

  // Garde : "Chemise ... prix : 7500" n'est PAS le format structuré — le nom
  // se terminerait par une étiquette de prix/quantité. → forme libre.
  if (/(?:\b(?:prix|pu|co[uû]t|tarif|stock|qt[eé]|quantit[eé]|reste))\s*$/i.test(rawName)) return null;

  return {
    name: rawName ? rawName.trim() : null,
    price: rawPrice ? parseWestAfricanPrice(rawPrice) : null,
    quantity: rawQty ? parseFloat(rawQty.replace(',', '.')) : null,
    unit: normalizeUnit(rawUnit),
    sizes: [],
    colors: [],
    sku: sku ? sku.toUpperCase() : null,
    action: sign === '+' ? 'add_stock' : sign === '-' ? 'subtract_stock' : 'set_stock',
    category: null,
  };
}

module.exports = { extractStructured, LINE_REGEX };
