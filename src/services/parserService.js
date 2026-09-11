'use strict';

/**
 * WAKANECT — Parser en cascade
 *
 * Couches :
 *   1. Pré-filtre   : salutations / messages sans chiffre → skipped
 *   2. Regex        : extraction structurée sans IA (gratuit) — voir ./parsing/
 *   3. Cloudflare   : Llama-3.1-8B (gratuit, Workers AI) — NOM UNIQUEMENT,
 *                      avec les indices déjà trouvés par la regex
 *   4. Décision     : garde-fous déterministes + recouvrement texte + niveau
 *                      de confiance du modèle → accept / correction / full_reparse
 *                      (voir ./parsing/nameValidation.js)
 *   5. DeepSeek     : soit une question de correction ciblée (bon marché),
 *                      soit un reparsing complet — jamais depuis zéro sans
 *                      les indices déjà trouvés
 *   6. Haiku        : dernier recours si DeepSeek échoue (ex: erreur réseau) —
 *                      inutilisé en pratique tant que la vérification d'identité
 *                      Anthropic n'est pas débloquée
 *
 * Toute la couche regex (formats STOCK structurés + forme libre) vit dans
 * src/services/parsing/ ; ce fichier orchestre la cascade et les appels IA.
 */

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { extractWithRegex, splitIntoProductLines, normalizeUnit } = require('./parsing');
const { validateNameDeterministic, resolveNameDecision } = require('./parsing/nameValidation');

// ─── Seuils (point de départ — à calibrer après la semaine pilote) ─────────────
const REGEX_ACCEPT      = 75;  // confidence >= ce seuil ET nom valide → on n'appelle pas l'IA
const CONFIDENCE_REVIEW = 80;  // confidence < ce seuil → needsReview = true

// ─── Cloudflare Workers AI — nom uniquement ────────────────────────────────────
const CF_MODEL      = process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const CF_TIMEOUT_MS = 8_000;

const CF_NAME_SYSTEM_PROMPT = `Tu es la deuxième passe d'un pipeline d'extraction de produits pour des commerçants ouest-africains sur WhatsApp.

Un premier passage automatique (regex) a déjà extrait ce qu'il a pu (prix, quantité, tailles, couleurs). Ton seul travail : trouver le NOM du produit dans le texte, en ignorant tout ce qui n'est pas le produit lui-même — salutations, promesses de livraison, état de stock, arguments de vente, emojis.

Important : garde dans le nom les caractéristiques qui distinguent précisément ce produit d'une variante similaire — capacité de stockage, taille d'écran, modèle exact. "iPhone 13" et "iPhone 13 128Go" ne sont PAS le même niveau de précision : préfère toujours la version la plus précise que le texte permet.

Retourne UNIQUEMENT du JSON valide (aucun texte avant ou après, aucune balise markdown) :
{
  "name": "nom du produit uniquement, ou null si vraiment introuvable",
  "name_confidence": "HIGH" ou "MEDIUM" ou "LOW"
}

Règles :
- "name_confidence" reflète ta certitude sur CE nom précis, pas sur le message en général.
- Ne jamais inventer une marque ou un détail absent du texte.
- Si le texte ne contient clairement aucun nom de produit exploitable, mets name à null et name_confidence à "LOW".`;

// ─── DeepSeek — deux prompts distincts selon le chemin de décision ────────────
const DEEPSEEK_MODEL      = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_URL        = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_TIMEOUT_MS = 15_000;

const DEEPSEEK_CORRECTION_SYSTEM_PROMPT = `Tu vérifies un nom de produit déjà extrait d'un message WhatsApp d'un commerçant ouest-africain.

On te donne le texte brut et un nom candidat, probablement déjà bon ou presque. Confirme-le s'il est juste, corrige-le seulement s'il est imprécis ou incomplet. Ne le réécris pas depuis zéro.

Retourne UNIQUEMENT du JSON valide :
{
  "name": "nom confirmé ou corrigé",
  "category": "catégorie courte, ex: Vêtements, Chaussures, Cosmétiques, Électronique, Tissus, Accessoires, Autre"
}`;

const DEEPSEEK_FULL_SYSTEM_PROMPT = `Tu es la dernière passe d'un pipeline d'extraction de produits pour des commerçants ouest-africains sur WhatsApp.

Les passages précédents (regex, puis un premier modèle IA) n'ont pas réussi à produire un nom de produit fiable. Reprends l'extraction depuis le texte brut, en tenant compte des indices déjà détectés.

Retourne UNIQUEMENT du JSON valide (aucun texte avant ou après, aucune balise markdown) :
{
  "name": "nom du produit, sans les phrases hors-sujet du vendeur",
  "price": nombre ou null (FCFA, entier sans séparateurs),
  "quantity": nombre ou null,
  "unit": "pièce",
  "sizes": [],
  "colors": [],
  "category": "catégorie courte, ex: Vêtements, Chaussures, Cosmétiques, Électronique, Tissus, Accessoires, Autre"
}

Règles :
- Si un indice du premier passage est donné, reprends sa valeur sauf si le texte brut la contredit clairement.
- "name" : ignore tout ce qui n'est pas le produit lui-même.
- En Afrique de l'Ouest le point sépare les milliers : "25.000f" = 25000 FCFA.
- Ne jamais inventer : si un champ n'est pas clair, mets null ou [].`;

// Prompt Haiku (dernier recours) — reste générique et complet, comme avant
const AI_SYSTEM_PROMPT = DEEPSEEK_FULL_SYSTEM_PROMPT;

// ─── Pré-filtre ────────────────────────────────────────────────────────────────

const GREETING_RE = /^(?:bonjour|bonsoir|bjr|bj|salut|slt|coucou|merci|mci|ok|oui|non|ça va|ca va|d'accord|dacord|hello|hi|bonne nuit|bonne journée|bonne matinée|👍|❤️|🙏|😊)\s*[!?.🙏👍😊]*$/iu;

function preFilter(text) {
  const t = text.trim();
  if (t.length < 4) return false;
  if (GREETING_RE.test(t)) return false;
  if (!/\d/.test(t)) return false;
  return true;
}

// ─── Confiance — calculée par validation des champs, JAMAIS auto-notée ────────

/**
 * `rawText`, si fourni, active la validation déterministe du nom (garde-fous
 * de ./parsing/nameValidation.js) au lieu d'un simple test de présence.
 * Omis → comportement historique préservé.
 */
function computeConfidence(product, rawText) {
  let score = 0;

  const nameOk = rawText
    ? validateNameDeterministic(product.name, rawText).valid
    : Boolean(product.name && product.name.trim().length >= 2);
  if (nameOk) score += 40;

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

function countNameTokens(name) {
  if (!name) return 0;
  return String(name).trim().split(/\s+/).filter(Boolean).length;
}

/** Résume les champs déjà trouvés par la regex, à passer en contexte aux IA. */
function buildHintsBlock(product) {
  const hints = [];
  if (product.price != null) hints.push(`prix détecté = ${product.price} FCFA`);
  if (product.quantity != null) hints.push(`quantité détectée = ${product.quantity}`);
  if (product.sizes?.length) hints.push(`tailles détectées = ${product.sizes.join(', ')}`);
  if (product.colors?.length) hints.push(`couleurs détectées = ${product.colors.join(', ')}`);
  return hints.length ? hints.join('\n') : 'Aucun champ détecté avec certitude par le premier passage.';
}

// ─── Appels IA ─────────────────────────────────────────────────────────────────

async function callCloudflareName(text, regexProduct) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN manquants');

  const userContent = `Message du commerçant :\n"""${text}"""\n\nIndices déjà détectés par le premier passage :\n${buildHintsBlock(regexProduct)}`;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`;
  const resp = await axios.post(
    url,
    { messages: [{ role: 'system', content: CF_NAME_SYSTEM_PROMPT }, { role: 'user', content: userContent }], max_tokens: 200 },
    { headers: { Authorization: `Bearer ${apiToken}` }, timeout: CF_TIMEOUT_MS }
  );

  const raw = resp.data?.result?.response;
  if (!raw) throw new Error('Cloudflare : réponse vide');

  const jsonM = raw.match(/\{[\s\S]*\}/);
  if (!jsonM) throw new Error('Cloudflare : JSON introuvable dans la réponse');

  const usage = resp.data?.result?.usage || {};
  console.log(`[parser:cf-name] tokens in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0}`);
  return JSON.parse(jsonM[0]);
}

async function callDeepSeekJson(systemPrompt, userContent) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY manquant');

  const resp = await axios.post(
    DEEPSEEK_URL,
    {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: DEEPSEEK_TIMEOUT_MS }
  );

  const raw = resp.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('DeepSeek : réponse vide');

  const usage = resp.data?.usage || {};
  console.log(`[parser:deepseek] tokens in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} cache_hit=${usage.prompt_cache_hit_tokens || 0}`);
  return { data: JSON.parse(raw), usage };
}

function callDeepSeekCorrection(text, candidateName) {
  const userContent = `Message du commerçant :\n"""${text}"""\n\nNom candidat à vérifier : "${candidateName}"`;
  return callDeepSeekJson(DEEPSEEK_CORRECTION_SYSTEM_PROMPT, userContent);
}

function callDeepSeekFullReparse(text, regexProduct, rejectedName, rejectionReason) {
  const rejectedNote = rejectedName
    ? `\nNom précédemment tenté (rejeté, raison : ${rejectionReason || 'inconnue'}) : "${rejectedName}" — ne le reprends pas tel quel.`
    : '';
  const userContent = `Message du commerçant :\n"""${text}"""\n\nIndices déjà détectés par le premier passage :\n${buildHintsBlock(regexProduct)}${rejectedNote}`;
  return callDeepSeekJson(DEEPSEEK_FULL_SYSTEM_PROMPT, userContent);
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
    system: [{ type: 'text', text: AI_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: text }],
  });

  const raw = msg.content[0]?.text || '';
  const jsonM = raw.match(/\{[\s\S]*\}/);
  if (!jsonM) throw new Error('Haiku : JSON introuvable');

  const u = msg.usage || {};
  console.log(`[parser:haiku] tokens in=${u.input_tokens} out=${u.output_tokens} cache_hit=${u.cache_read_input_tokens || 0}`);
  return { data: JSON.parse(jsonM[0]), usage: u };
}

function normalizeAiProduct(raw, fallback = {}) {
  return {
    name: typeof raw.name === 'string' ? raw.name.trim() || null : null,
    price: typeof raw.price === 'number' && raw.price > 0 ? raw.price : (fallback.price ?? null),
    quantity: typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : (fallback.quantity ?? null),
    unit: normalizeUnit(raw.unit) || fallback.unit || 'pièce',
    sizes: Array.isArray(raw.sizes) ? raw.sizes.map(String) : (fallback.sizes || []),
    colors: Array.isArray(raw.colors) ? raw.colors.map((c) => String(c).toLowerCase()) : (fallback.colors || []),
    category: raw.category || fallback.category || null,
    sku: fallback.sku ?? null,
    action: 'set_stock',
  };
}

// ─── Fonction principale ──────────────────────────────────────────────────────

async function parseProduct(text) {
  const startMs = Date.now();
  const message = String(text || '').trim();

  const meta = {
    regexAttempted: false, regexSuccess: false,
    cloudflareAttempted: false, cloudflareSuccess: false,
    deepseekAttempted: false, deepseekPath: null,
    deepseekInputTokens: 0, deepseekOutputTokens: 0, deepseekCachedTokens: 0,
    haikuAttempted: false,
    haikuInputTokens: 0, haikuOutputTokens: 0, haikuCachedTokens: 0,
    haikuErrored: false,
    nameDecisionPath: null, nameDecisionReason: null,
    latencyMs: 0,
  };

  if (!preFilter(message)) {
    return { status: 'skipped', parserTier: 'skipped', confidence: 0, needsReview: false, missingCritical: [], product: null, _meta: { ...meta, latencyMs: Date.now() - startMs } };
  }

  // Tier 1 — regex
  meta.regexAttempted = true;
  const regexProduct = extractWithRegex(message);
  const regexConf = computeConfidence(regexProduct, message);
  meta.regexSuccess = regexConf >= REGEX_ACCEPT;
  console.log(`[parser:regex] conf=${regexConf} name="${regexProduct.name}" price=${regexProduct.price}`);

  if (regexConf >= REGEX_ACCEPT) {
    return _buildResult('regex', regexProduct, regexConf, { ...meta, latencyMs: Date.now() - startMs });
  }

  // Tier 2 — Cloudflare, nom uniquement
  let cfName = null, cfNameConfidence = 'LOW', cfErrored = false;
  meta.cloudflareAttempted = true;
  try {
    const cfRaw = await callCloudflareName(message, regexProduct);
    cfName = typeof cfRaw.name === 'string' ? cfRaw.name.trim() || null : null;
    cfNameConfidence = ['HIGH', 'MEDIUM', 'LOW'].includes(cfRaw.name_confidence) ? cfRaw.name_confidence : 'LOW';
    meta.cloudflareSuccess = true;
    console.log(`[parser:cf-name] name="${cfName}" confidence=${cfNameConfidence}`);
  } catch (err) {
    console.warn(`[parser] Cloudflare (nom) → passage direct à DeepSeek en reparsing complet : ${err.message}`);
    cfErrored = true;
  }

  // Décision : accept / correction / full_reparse — jamais un score auto-noté seul
  const decision = cfErrored
    ? { path: 'full_reparse', reason: 'cloudflare_error' }
    : resolveNameDecision({
        name: cfName,
        rawText: message,
        aiConfidenceLevel: cfNameConfidence,
        aiTokenCount: countNameTokens(cfName),
      });
  meta.nameDecisionPath = decision.path;
  meta.nameDecisionReason = decision.reason || null;
  console.log(`[parser:decision] path=${decision.path} reason=${decision.reason || '-'} overlap=${decision.overlap ?? '-'} aiScore=${decision.aiScore ?? '-'}`);

  if (decision.path === 'accept') {
    const product = { ...regexProduct, name: cfName };
    const conf = computeConfidence(product, message);
    return _buildResult('cloudflare', product, conf, { ...meta, latencyMs: Date.now() - startMs });
  }

  // Tier 3 — DeepSeek (correction ciblée ou reparsing complet), Haiku en filet
  meta.deepseekAttempted = true;
  meta.deepseekPath = decision.path === 'correction' ? 'correction' : 'full';
  try {
    let dsProduct, dsUsage;
    if (decision.path === 'correction') {
      const { data, usage } = await callDeepSeekCorrection(message, cfName);
      dsUsage = usage;
      dsProduct = { ...regexProduct, name: (data.name || cfName), category: data.category || null };
    } else {
      const { data, usage } = await callDeepSeekFullReparse(message, regexProduct, cfName, decision.reason);
      dsUsage = usage;
      dsProduct = normalizeAiProduct(data, regexProduct);
    }

    meta.deepseekInputTokens  = dsUsage.prompt_tokens              || 0;
    meta.deepseekOutputTokens = dsUsage.completion_tokens          || 0;
    meta.deepseekCachedTokens = dsUsage.prompt_cache_hit_tokens    || 0;

    const dsConf = computeConfidence(dsProduct, message);
    const tier = decision.path === 'correction' ? 'deepseek_correction' : 'deepseek_full';
    console.log(`[parser:${tier}] conf=${dsConf} name="${dsProduct.name}" price=${dsProduct.price}`);
    return _buildResult(tier, dsProduct, dsConf, { ...meta, latencyMs: Date.now() - startMs });
  } catch (err) {
    console.warn(`[parser] DeepSeek → bascule Haiku : ${err.message}`);
  }

  // Tier 4 — Haiku, dernier recours
  meta.haikuAttempted = true;
  try {
    const { data: haikuRaw, usage: haikuUsage } = await callHaiku(message);
    meta.haikuInputTokens  = haikuUsage.input_tokens              || 0;
    meta.haikuOutputTokens = haikuUsage.output_tokens             || 0;
    meta.haikuCachedTokens = haikuUsage.cache_read_input_tokens   || 0;
    const haikuProduct = normalizeAiProduct(haikuRaw, regexProduct);
    const haikuConf = computeConfidence(haikuProduct, message);
    console.log(`[parser:haiku] conf=${haikuConf} name="${haikuProduct.name}" price=${haikuProduct.price}`);
    return _buildResult('haiku', haikuProduct, haikuConf, { ...meta, latencyMs: Date.now() - startMs });
  } catch (err) {
    console.error(`[parser] Haiku erreur : ${err.message}`);
    meta.haikuErrored = true;
    const cfDetValid = cfName && validateNameDeterministic(cfName, message).valid;
    const best     = cfDetValid ? { ...regexProduct, name: cfName } : regexProduct;
    const bestTier = cfDetValid ? 'cloudflare' : 'regex';
    const bestConf = computeConfidence(best, message);
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