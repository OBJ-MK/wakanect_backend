'use strict';

/**
 * WAKANECT — Parser en cascade
 *
 * Couches :
 *   1. Pré-filtre   : salutations / messages sans chiffre → skipped
 *   2. Regex        : extraction structurée sans IA (gratuit) — voir ./parsing/
 *   3. Cloudflare   : Llama-3.1-8B (gratuit, Workers AI — configurable via CF_MODEL)
 *   4. Haiku        : Claude Haiku (prompt caching sur le system prompt)
 *
 * Toute la couche regex (formats STOCK structurés + forme libre) vit dans
 * src/services/parsing/ ; ce fichier orchestre la cascade et les appels IA.
 */

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { extractWithRegex, splitIntoProductLines, normalizeUnit } = require('./parsing');

// ─── Seuils (point de départ — à calibrer après la semaine pilote) ─────────────
const REGEX_ACCEPT    = 75;  // confidence >= ce seuil → on n'appelle pas l'IA
const CF_ACCEPT       = 65;  // confidence CF >= ce seuil → on n'appelle pas Haiku
const CONFIDENCE_REVIEW = 80; // confidence < ce seuil → needsReview = true

// ─── Cloudflare Workers AI ─────────────────────────────────────────────────────
const CF_MODEL      = process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct';
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
