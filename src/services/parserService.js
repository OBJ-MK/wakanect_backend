/**
 * WAZALINK — Parser de messages WhatsApp
 * 
 * Format attendu (structuré, documenté pour les commerçants) :
 * 
 * FORMAT 1 — Mise à jour stock simple :
 *   STOCK
 *   Tomates : 50 kg
 *   Oignons : 30 kg
 *   Riz 25kg : 100 sacs
 * 
 * FORMAT 2 — Mise à jour avec prix :
 *   STOCK
 *   Tomates : 50 kg | 500 FCFA
 *   Oignons : 30 kg | 350 FCFA/kg
 * 
 * FORMAT 3 — Ajout de stock (+ devant) :
 *   STOCK
 *   +Tomates : 20 kg
 *   -Oignons : 5 kg   (déduction)
 * 
 * FORMAT 4 — Avec SKU :
 *   STOCK
 *   [TOM001] Tomates : 50 kg
 *   [RIZ-5KG] Riz basmati 5kg : 200 sacs
 */

const Product = require('../models/Product');

// ─── Regex Patterns ────────────────────────────────────────────────────────────

// Détecte le type de message (header obligatoire)
const HEADER_REGEX = /^(STOCK|stock|Stock)\s*$/m;

// Ligne de produit : [SKU optionnel] [+/-] Nom : quantité [unité] [| prix [FCFA]]
const LINE_REGEX =
  /^(?:\[([A-Z0-9_-]+)\]\s*)?([+-])?(.+?)\s*:\s*(\d+(?:[.,]\d+)?)\s*([a-zA-ZÀ-ÿ]+)?\s*(?:\|\s*(\d+(?:[.,]\d+)?)\s*(FCFA|XOF|CFA|F)?(?:\/[a-zA-Z]+)?)?$/;

const UNITS = ['kg', 'g', 'litre', 'l', 'ml', 'pièce', 'piece', 'sac', 'sachet', 'boite', 'carton', 'unité', 'unite', 'pack'];

/**
 * Parse une ligne individuelle du message
 * @param {string} line 
 * @returns {object|null}
 */
const parseLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return null;

  const match = trimmed.match(LINE_REGEX);
  if (!match) return null;

  const [, sku, sign, rawName, rawQty, rawUnit, rawPrice] = match;

  const quantity = parseFloat(rawQty.replace(',', '.'));
  const price = rawPrice ? parseFloat(rawPrice.replace(',', '.')) : null;
  const unit = normalizeUnit(rawUnit);
  const action = sign === '+' ? 'add_stock' : sign === '-' ? 'subtract_stock' : 'set_stock';

  return {
    rawText: trimmed,
    sku: sku ? sku.toUpperCase() : null,
    productName: rawName.trim(),
    quantity,
    unit,
    price,
    action,
    lineStatus: 'pending',
    matchConfidence: 'none',
    matchedProductId: null,
  };
};

/**
 * Normalise l'unité détectée
 */
const normalizeUnit = (raw) => {
  if (!raw) return 'pièce';
  const lower = raw.toLowerCase();
  if (['kg', 'kilo', 'kilos'].includes(lower)) return 'kg';
  if (['g', 'gr', 'gramme', 'grammes'].includes(lower)) return 'g';
  if (['l', 'litre', 'litres'].includes(lower)) return 'litre';
  if (['ml'].includes(lower)) return 'ml';
  if (['sac', 'sacs'].includes(lower)) return 'sac';
  if (['sachet', 'sachets'].includes(lower)) return 'sachet';
  if (['boite', 'boites', 'boîte', 'boîtes'].includes(lower)) return 'boite';
  if (['carton', 'cartons'].includes(lower)) return 'carton';
  if (['pack', 'packs'].includes(lower)) return 'pack';
  return lower;
};

/**
 * Matching produit en base (exact sur SKU, fuzzy sur nom)
 */
const matchProducts = async (parsedItems, merchantId) => {
  // Récupérer tous les produits du commerçant en une seule requête
  const products = await Product.find({ merchantId }).lean();

  return parsedItems.map((item) => {
    // 1. Match exact par SKU
    if (item.sku) {
      const bySkU = products.find(
        (p) => p.sku && p.sku.toUpperCase() === item.sku.toUpperCase()
      );
      if (bySkU) {
        return {
          ...item,
          matchedProductId: bySkU._id,
          matchConfidence: 'exact',
        };
      }
    }

    // 2. Match exact par nom (insensible à la casse)
    const byName = products.find(
      (p) => p.name.toLowerCase() === item.productName.toLowerCase()
    );
    if (byName) {
      return {
        ...item,
        matchedProductId: byName._id,
        matchConfidence: 'exact',
      };
    }

    // 3. Match partiel (le nom du produit est contenu dans l'entrée ou vice-versa)
    const byPartial = products.find(
      (p) =>
        p.name.toLowerCase().includes(item.productName.toLowerCase()) ||
        item.productName.toLowerCase().includes(p.name.toLowerCase())
    );
    if (byPartial) {
      return {
        ...item,
        matchedProductId: byPartial._id,
        matchConfidence: 'fuzzy',
        action: item.action === 'set_stock' ? 'set_stock' : item.action,
      };
    }

    // 4. Aucun match → nouveau produit potentiel
    return {
      ...item,
      action: 'new_product',
      matchConfidence: 'none',
    };
  });
};

/**
 * Parse le message complet
 * @param {string} messageBody  - Corps du message WhatsApp
 * @param {string} merchantId   - ID du commerçant
 * @returns {{ valid: boolean, parsedItems: [], error: string|null }}
 */
const parseStockMessage = async (messageBody, merchantId) => {
  const body = messageBody.trim();

  // Vérification du header
  if (!HEADER_REGEX.test(body)) {
    return {
      valid: false,
      parsedItems: [],
      error:
        'Format non reconnu. Le message doit commencer par "STOCK" sur la première ligne.',
    };
  }

  // Extraire les lignes (après le header)
  const lines = body
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return {
      valid: false,
      parsedItems: [],
      error: 'Aucun produit trouvé dans le message.',
    };
  }

  // Parser chaque ligne
  const parsedItems = [];
  const unparsedLines = [];

  for (const line of lines) {
    const item = parseLine(line);
    if (item) {
      parsedItems.push(item);
    } else {
      unparsedLines.push(line.trim());
    }
  }

  if (parsedItems.length === 0) {
    return {
      valid: false,
      parsedItems: [],
      error: `Aucune ligne valide. Format attendu : "Produit : quantité unité"\nLignes ignorées : ${unparsedLines.join(', ')}`,
    };
  }

  // Tenter le matching produits en base
  const itemsWithMatch = await matchProducts(parsedItems, merchantId);

  return {
    valid: true,
    parsedItems: itemsWithMatch,
    unparsedLines,
    error: null,
    summary: {
      total: parsedItems.length,
      matched: itemsWithMatch.filter((i) => i.matchConfidence !== 'none').length,
      newProducts: itemsWithMatch.filter((i) => i.action === 'new_product').length,
      unparsed: unparsedLines.length,
    },
  };
};

module.exports = { parseStockMessage, parseLine, normalizeUnit };
