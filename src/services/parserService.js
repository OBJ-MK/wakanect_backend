'use strict';

/**
 * WAKANECT — Parser en cascade
 *
 * Couches :
 *   1. Pré-filtre   : salutations / messages sans chiffre → skipped
 *   2. Regex        : extraction structurée sans IA (gratuit)
 *   3. Cloudflare   : Mistral-7B (gratuit, Workers AI)
 *   4. Haiku        : Claude Haiku (prompt caching sur le system prompt)
 *
 * Les 4 anciens formats (STOCK header + lignes structurées) ET le nouveau
 * format libre ("Baskets Nike 40 41 42, blanc/noir, 25.000f, 8 pièces")
 * sont tous pris en charge par la couche regex.
 */

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Seuils (point de départ — à calibrer après la semaine pilote) ─────────────
const REGEX_ACCEPT    = 75;  // confidence >= ce seuil → on n'appelle pas l'IA
const CF_ACCEPT       = 65;  // confidence CF >= ce seuil → on n'appelle pas Haiku
const CONFIDENCE_REVIEW = 80; // confidence < ce seuil → needsReview = true

// ─── Cloudflare Workers AI ─────────────────────────────────────────────────────
const CF_MODEL      = '@cf/mistralai/mistral-7b-instruct-v0.2';
const CF_TIMEOUT_MS = 8_000;

// ─── Prompt système partagé (Cloudflare + Haiku) ───────────────────────────────
const AI_SYSTEM_PROMPT = `Tu es un assistant d'extraction de produits pour des commerçants ouest-africains.
Extrais les informations du message WhatsApp et retourne UNIQUEMENT du JSON valide (aucun texte avant ou après).

Format attendu (tous les champs obligatoires) :
{
  "name": "nom du produit",
  "price": nombre ou null (en FCFA, entier sans séparateurs),
  "quantity": nombre ou null,
  "unit": "pièce",
  "sizes": [],
  "colors": [],
  "category": null
}

Règles critiques :
- En Afrique de l'Ouest le point sépare les milliers : "25.000f" = 25000 FCFA
- "3 500 CFA" = 3500, "25000F" = 25000, "25.000 FCFA" = 25000
- Ne jamais inventer : si un champ n'est pas clair, mets null ou []
- Retourne uniquement le JSON, sans explication ni balise markdown`;

// ─── Pré-filtre ────────────────────────────────────────────────────────────────

const GREETING_RE = /^(?:bonjour|bonsoir|bjr|bj|salut|slt|coucou|merci|mci|ok|oui|non|ça va|ca va|d'accord|dacord|hello|hi|bonne nuit|bonne journée|bonne matinée|👍|❤️|🙏|😊)\s*[!?.🙏👍😊]*$/iu;

/**
 * Retourne true si le message ressemble à une mise à jour produit.
 * Salutations et messages sans chiffre → false (→ 'skipped', pas de scan compté).
 */
function preFilter(text) {
  const t = text.trim();
  if (t.length < 4) return false;
  if (GREETING_RE.test(t)) return false;
  // Un message produit a toujours au moins un chiffre (prix ou quantité)
  if (!/\d/.test(t)) return false;
  return true;
}

// ─── Normalisation des unités ─────────────────────────────────────────────────

function normalizeUnit(raw) {
  if (!raw) return 'pièce';
  const s = raw.toLowerCase().replace(/s$/, '');
  const map = {
    kg: 'kg', kilo: 'kg',
    g: 'g', gr: 'g', gramme: 'g',
    litre: 'litre', l: 'litre',
    ml: 'ml',
    sac: 'sac', sachet: 'sachet',
    boite: 'boite', boîte: 'boite',
    carton: 'carton',
    pack: 'pack',
    pc: 'pièce', pièce: 'pièce', piece: 'pièce',
    unité: 'pièce', unite: 'pièce',
  };
  return map[s] || s;
}

// ─── Parsing prix (séparateur milliers ouest-africain) ────────────────────────

/**
 * Convertit "25.000", "3 500", "25000" en nombre.
 * Les formats X.XXX et X,XXX (1–3 chiffres + séparateur + 3 chiffres) → milliers.
 */
function parseWestAfricanPrice(raw) {
  const s = raw.trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return parseInt(s.replace(/,/g, ''), 10);
  const v = parseFloat(s.replace(',', '.'));
  return isNaN(v) ? null : v;
}

// ─── Confiance — calculée par validation des champs, JAMAIS auto-notée ────────

function computeConfidence(product) {
  let score = 0;
  if (product.name && product.name.trim().length >= 2) score += 40;
  if (product.price != null && product.price > 0) score += 35;
  if (product.quantity != null && product.quantity > 0) score += 15;
  if (product.unit && product.unit !== 'pièce') score += 5;
  if ((product.sizes && product.sizes.length > 0) || (product.colors && product.colors.length > 0)) score += 5;
  return score;
}

function computeMissingCritical(product) {
  const missing = [];
  if (!product.name || product.name.trim().length < 2) missing.push('name');
  if (product.price == null || product.price <= 0) missing.push('price');
  return missing;
}

// ─── Extraction regex (formats structurés + format libre) ─────────────────────

// Ancien format structuré (4 formats STOCK)
const LINE_REGEX =
  /^(?:\[([A-Z0-9_-]+)\]\s*)?([+-])?(.+?)\s*:\s*(\d+(?:[.,]\d+)?)\s*([a-zA-ZÀ-ÿ]+)?\s*(?:\|\s*(\d+(?:[.\s,]\d+)?)\s*(FCFA|XOF|CFA|F)?(?:\/[a-zA-Z]+)?)?$/;

const KNOWN_COLORS = new Set([
  'blanc', 'blanche', 'noir', 'noire', 'rouge', 'bleu', 'bleue',
  'vert', 'verte', 'jaune', 'marron', 'gris', 'grise', 'rose',
  'orange', 'violet', 'violette', 'beige', 'or', 'doré', 'argent',
]);

const UNITS_PAT = 'kg|g(?:r)?|litres?|(?<![a-zÀ-ÿ])l(?![a-zÀ-ÿ])|ml|sacs?|sachets?|pièces?|pieces?|pcs?|boîtes?|boites?|cartons?|unités?|unites?|packs?';

/**
 * Extraction libre (nouveau format : "Baskets Nike 40 41 42, blanc/noir, 25.000f, 8 pièces")
 */
function extractFreeForm(text) {
  let w = text;
  let price = null, quantity = null, unit = 'pièce';
  let sku = null, action = 'set_stock';
  const sizes = [], colors = [];

  // SKU entre crochets : [TOM001]
  w = w.replace(/\[([A-Z0-9_-]+)\]/gi, (_, s) => { sku = s.toUpperCase(); return ' '; });

  // Signe +/- en début (add/subtract stock)
  const signMatch = w.match(/^\s*([+-])/);
  if (signMatch) {
    action = signMatch[1] === '+' ? 'add_stock' : 'subtract_stock';
    w = w.slice(signMatch.index + 1);
  }

  // Prix avec marqueur devise — gère "25.000f", "25 000 FCFA", "3 500 CFA", "500F/kg"
  const priceRE = /\b(\d+(?:[.\s]\d+)*)\s*(?:FCFA|XOF|CFA|F(?![A-Za-zÀ-ÿ]))/gi;
  const priceM = priceRE.exec(w);
  if (priceM) {
    price = parseWestAfricanPrice(priceM[1]);
    w = w.slice(0, priceM.index) + ' ' + w.slice(priceM.index + priceM[0].length);
  }

  // Quantité + unité
  const qtyRE = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${UNITS_PAT})\\b`, 'gi');
  const qtyM = qtyRE.exec(w);
  if (qtyM) {
    quantity = parseFloat(qtyM[1].replace(',', '.'));
    unit = normalizeUnit(qtyM[2]);
    w = w.slice(0, qtyM.index) + ' ' + w.slice(qtyM.index + qtyM[0].length);
  } else if (price !== null) {
    // Nombre isolé à la fin (ex. "… 8" sans unité)
    const bareM = w.match(/\b(\d{1,4})\s*$/);
    if (bareM) {
      quantity = parseInt(bareM[1], 10);
      w = w.slice(0, bareM.index).trim();
    }
  }

  // Pointures chaussures : 2+ nombres consécutifs en 28–50
  w = w.replace(/\b(?:(?:2[89]|[34]\d|50)(?:\s*[,\/]\s*|\s+))+(?:2[89]|[34]\d|50)\b/g, (match) => {
    const found = match.match(/\b(?:2[89]|[34]\d|50)\b/g) || [];
    if (found.length >= 2) { sizes.push(...found); return ' '; }
    return match;
  });

  // Tailles vêtements : XS S M L XL XXL XXXL
  w = w.replace(/\b(XXX?L|XXL|XL|XS|[SML])\b/gi, (m) => { sizes.push(m.toUpperCase()); return ' '; });

  // Couleurs séparées par "/" → "blanc/noir"
  w = w.replace(/\b([a-zÀ-ÿ]+)\/([a-zÀ-ÿ]+)\b/gi, (match, c1, c2) => {
    let hit = false;
    if (KNOWN_COLORS.has(c1.toLowerCase())) { colors.push(c1.toLowerCase()); hit = true; }
    if (KNOWN_COLORS.has(c2.toLowerCase())) { colors.push(c2.toLowerCase()); hit = true; }
    return hit ? ' ' : match;
  });

  // Mots-couleurs isolés
  for (const color of KNOWN_COLORS) {
    const re = new RegExp(`\\b${color}\\b`, 'gi');
    if (re.test(w) && !colors.includes(color)) {
      colors.push(color);
      w = w.replace(re, ' ');
    }
  }

  // Nom = ce qui reste après nettoyage
  const name = w
    .replace(/[-,|;:\/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;

  return { name, price, quantity, unit, sizes: [...new Set(sizes)], colors: [...new Set(colors)], sku, action, category: null };
}

/**
 * Couche regex — essaie d'abord le format structuré (`:` + `|`), sinon forme libre.
 */
function extractWithRegex(text) {
  const t = text.trim();

  // Format structuré : [SKU] [±] Nom : quantité [unité] [| prix [FCFA]]
  const lineM = t.match(LINE_REGEX);
  if (lineM) {
    const [, sku, sign, rawName, rawQty, rawUnit, rawPrice] = lineM;
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

  return extractFreeForm(t);
}

// ─── Appels IA ─────────────────────────────────────────────────────────────────

// `text` est exclusivement le message produit WhatsApp du commerçant (ex: "Baskets Nike 40, 25000f, 8 pcs").
// Il ne contient jamais de credentials — le pré-filtre rejette les messages non-produit en amont.
async function callCloudflare(text) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN manquants');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`;
  const resp = await axios.post(
    url,
    { messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: text }], max_tokens: 256 },
    { headers: { Authorization: `Bearer ${apiToken}` }, timeout: CF_TIMEOUT_MS }
  );

  const raw = resp.data?.result?.response;
  if (!raw) throw new Error('Cloudflare : réponse vide');

  const jsonM = raw.match(/\{[\s\S]*\}/);
  if (!jsonM) throw new Error('Cloudflare : JSON introuvable dans la réponse');

  const usage = resp.data?.result?.usage || {};
  console.log(`[parser:cf] tokens in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0}`);
  return JSON.parse(jsonM[0]);
}

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

async function callHaiku(text) {
  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    // Prompt caching sur le system prompt — évite de le re-tokeniser à chaque appel
    system: [{ type: 'text', text: AI_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: text }],
  });

  const raw = msg.content[0]?.text || '';
  const jsonM = raw.match(/\{[\s\S]*\}/);
  if (!jsonM) throw new Error('Haiku : JSON introuvable');

  const u = msg.usage || {};
  console.log(`[parser:haiku] tokens in=${u.input_tokens} out=${u.output_tokens} cache_hit=${u.cache_read_input_tokens || 0}`);
  // Retourne données + usage pour l'instrumentation (ParsingEvent)
  return { data: JSON.parse(jsonM[0]), usage: u };
}

/** Normalise la sortie d'un modèle IA vers la forme canonique du produit */
function normalizeAiProduct(raw) {
  return {
    name: typeof raw.name === 'string' ? raw.name.trim() || null : null,
    price: typeof raw.price === 'number' && raw.price > 0 ? raw.price : null,
    quantity: typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : null,
    unit: normalizeUnit(raw.unit),
    sizes: Array.isArray(raw.sizes) ? raw.sizes.map(String) : [],
    colors: Array.isArray(raw.colors) ? raw.colors.map((c) => String(c).toLowerCase()) : [],
    category: raw.category || null,
    sku: null,
    action: 'set_stock',
  };
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Découpe un message en lignes produits.
 * Si le message commence par "STOCK", chaque ligne est un produit séparé.
 * Sinon, le message entier est un seul produit.
 */
function splitIntoProductLines(text) {
  const t = text.trim();
  const headerRE = /^(STOCK|stock|Stock)\s*(\n|$)/m;
  if (headerRE.test(t)) {
    const lines = t.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines : [t];
  }
  return [t];
}

/**
 * Parse une ligne / message.
 *
 * Retourne :
 *   { status, parserTier, confidence, needsReview, missingCritical, product, _meta }
 *
 * status     : 'ok' | 'skipped'
 * parserTier : 'regex' | 'cloudflare' | 'haiku' | 'skipped'
 * _meta      : données d'instrumentation pour ParsingEvent (tokens, latence, flags)
 */
async function parseProduct(text) {
  const startMs = Date.now();
  const message = String(text || '').trim();

  const meta = {
    regexAttempted: false, regexSuccess: false,
    cloudflareAttempted: false, cloudflareSuccess: false,
    haikuAttempted: false,
    haikuInputTokens: 0, haikuOutputTokens: 0, haikuCachedTokens: 0,
    haikuErrored: false,
    latencyMs: 0,
  };

  if (!preFilter(message)) {
    return { status: 'skipped', parserTier: 'skipped', confidence: 0, needsReview: false, missingCritical: [], product: null, _meta: { ...meta, latencyMs: Date.now() - startMs } };
  }

  // Tier 1 — regex
  meta.regexAttempted = true;
  const regexProduct = extractWithRegex(message);
  const regexConf = computeConfidence(regexProduct);
  meta.regexSuccess = regexConf >= REGEX_ACCEPT;
  console.log(`[parser:regex] conf=${regexConf} name="${regexProduct.name}" price=${regexProduct.price}`);

  if (regexConf >= REGEX_ACCEPT) {
    return _buildResult('regex', regexProduct, regexConf, { ...meta, latencyMs: Date.now() - startMs });
  }

  // Tier 2 — Cloudflare (bascule silencieuse sur Haiku en cas d'erreur)
  meta.cloudflareAttempted = true;
  let cfProduct = null, cfConf = 0;
  try {
    cfProduct = normalizeAiProduct(await callCloudflare(message));
    cfConf = computeConfidence(cfProduct);
    meta.cloudflareSuccess = cfConf >= CF_ACCEPT;
    console.log(`[parser:cf] conf=${cfConf} name="${cfProduct.name}" price=${cfProduct.price}`);
    if (cfConf >= CF_ACCEPT) return _buildResult('cloudflare', cfProduct, cfConf, { ...meta, latencyMs: Date.now() - startMs });
  } catch (err) {
    console.warn(`[parser] Cloudflare → bascule Haiku : ${err.message}`);
  }

  // Tier 3 — Haiku (dernier recours)
  meta.haikuAttempted = true;
  try {
    const { data: haikuRaw, usage: haikuUsage } = await callHaiku(message);
    meta.haikuInputTokens  = haikuUsage.input_tokens              || 0;
    meta.haikuOutputTokens = haikuUsage.output_tokens             || 0;
    meta.haikuCachedTokens = haikuUsage.cache_read_input_tokens   || 0;
    const haikuProduct = normalizeAiProduct(haikuRaw);
    const haikuConf = computeConfidence(haikuProduct);
    console.log(`[parser:haiku] conf=${haikuConf} name="${haikuProduct.name}" price=${haikuProduct.price}`);
    return _buildResult('haiku', haikuProduct, haikuConf, { ...meta, latencyMs: Date.now() - startMs });
  } catch (err) {
    console.error(`[parser] Haiku erreur : ${err.message}`);
    meta.haikuErrored = true;
    // Retourne le meilleur résultat disponible
    const best     = cfProduct && cfConf >= regexConf ? cfProduct : regexProduct;
    const bestConf = cfProduct && cfConf >= regexConf ? cfConf    : regexConf;
    const bestTier = cfProduct && cfConf >= regexConf ? 'cloudflare' : 'regex';
    return _buildResult(bestTier, best, bestConf, { ...meta, latencyMs: Date.now() - startMs });
  }
}

function _buildResult(tier, product, confidence, meta = {}) {
  const missingCritical = computeMissingCritical(product);
  return {
    status: 'ok',
    parserTier: tier,
    confidence,
    needsReview: confidence < CONFIDENCE_REVIEW || missingCritical.length > 0,
    missingCritical,
    product,
    _meta: meta,
  };
}

module.exports = {
  parseProduct,
  splitIntoProductLines,
  preFilter,
  extractWithRegex,
  computeConfidence,
  normalizeUnit,
};
