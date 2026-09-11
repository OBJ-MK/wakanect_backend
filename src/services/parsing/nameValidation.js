// src/services/parsing/nameValidation.js

const GENERIC_NAME_BLACKLIST = new Set([
  'article', 'produit', 'sans nom', 'n a', 'na', 'inconnu', 'designation', 'item',
]);
const NAME_FORBIDDEN_RE = /\b(prix|disponible|livraison|whatsapp|contact|promo|port)\b/i;
const PRICE_RESIDUE_RE = /[₣$€£]|\bfcfa\b|\bcfa\b|\b\d+\s*(f|frs?|fcfa)\b/i;
const STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'à', 'en', 'pour', 'avec', 'sur']);

function normalize(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distance d'édition simple — sert uniquement à détecter "le modèle n'a rien extrait"
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Garde-fou déterministe sur le nom. Doit passer AVANT tout calcul de score —
 * aucun niveau de confiance du modèle ne peut compenser un échec ici.
 */
function validateNameDeterministic(name, rawText) {
  if (!name) return { valid: false, reason: 'empty' };
  const value = name.trim();

  if (value.length < 3) return { valid: false, reason: 'too_short' };
  if (value.length > 100) return { valid: false, reason: 'too_long' };
  if (PRICE_RESIDUE_RE.test(value)) return { valid: false, reason: 'contains_price' };
  if (NAME_FORBIDDEN_RE.test(value)) return { valid: false, reason: 'contains_marketing_noise' };

  // Rejette un nombre isolé de 4 chiffres ou plus (prix/référence qui a fuité),
  // mais laisse passer "iPhone 13", "128Go", "43 pouces" — chiffres courts
  // attachés à une unité ou une spec, légitimes dans ce domaine.
  const BARE_LONG_NUMBER_RE = /\b\d{4,}\b(?!\s*(go|mo|gb|mb|cm|mm|ml|pouces?|ans?|w|v)\b)/i;
  if (BARE_LONG_NUMBER_RE.test(value)) return { valid: false, reason: 'too_many_digits' };

  // Un vrai nom de produit dans ce domaine fait rarement plus de 8 mots — au-delà,
  // c'est le signe que la regex a juste retiré le bruit connu sans isoler un nom,
  // et a laissé une phrase entière (ex: "vient avec chargeur et boîte origine").
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return { valid: false, reason: 'too_many_words' };

  const normName = normalize(value);
  if (!/[a-zàâäéèêëïîôöùûüç]{3,}/.test(normName)) return { valid: false, reason: 'no_real_word' };
  if (GENERIC_NAME_BLACKLIST.has(normName)) return { valid: false, reason: 'generic_placeholder' };

  // Le modèle a-t-il juste recraché le texte brut sans rien isoler ?
  const normRaw = normalize(rawText).slice(0, normName.length + 30);
  const dist = levenshtein(normName, normRaw);
  const similarity = 1 - dist / Math.max(normName.length, normRaw.length, 1);
  if (similarity > 0.9) return { valid: false, reason: 'same_as_raw' };

  return { valid: true };
}

/**
 * Taux de recouvrement entre les mots du nom et le texte source — remplace la
 * notion d'"evidence" auto-déclarée par le modèle par une vérification qu'on
 * fait nous-même.
 */
function computeOverlapScore(name, rawText) {
  const nameTokens = normalize(name).split(' ').filter(t => t.length > 2 && !STOPWORDS.has(t));
  if (nameTokens.length === 0) return 0;
  const normRaw = normalize(rawText);
  const found = nameTokens.filter(t => normRaw.includes(t));
  return found.length / nameTokens.length; // 0..1
}

const CONFIDENCE_LEVEL_SCORE = { HIGH: 90, MEDIUM: 65, LOW: 35 };

/**
 * Décide du parcours pour un nom donné :
 *  - 'accept'       : livré au commerçant sans repasser par DeepSeek
 *  - 'correction'    : question ciblée à DeepSeek ("ce nom est-il correct ?"),
 *                      moins chère et plus fiable qu'un reparsing complet
 *  - 'full_reparse'  : DeepSeek reprend depuis le texte brut + les résultats
 *                      précédents (regex + Workers AI) comme contexte
 */
function resolveNameDecision({ name, rawText, aiConfidenceLevel, aiTokenCount }) {
  const det = validateNameDeterministic(name, rawText);
  if (!det.valid) {
    return { path: 'full_reparse', reason: det.reason, overlap: null, aiScore: null };
  }

  const overlap = computeOverlapScore(name, rawText);
  let aiScore = CONFIDENCE_LEVEL_SCORE[aiConfidenceLevel] ?? 0;
  if (aiTokenCount != null && aiTokenCount < 2) aiScore = Math.min(aiScore, 70);

  if (overlap >= 0.8 && aiScore >= 90) {
    return { path: 'accept', overlap, aiScore };
  }
  // Recouvrement quasi parfait avec le texte source : on fait davantage
  // confiance au texte lui-même qu'à l'auto-évaluation du modèle, même
  // quand celui-ci se déclare peu sûr (LOW). Évite un reparsing complet
  // inutile quand le nom est en fait déjà bon.
  if (overlap >= 0.9) {
    return { path: 'correction', overlap, aiScore };
  }
  if (overlap >= 0.5 && aiScore >= 65) {
    return { path: 'correction', overlap, aiScore };
  }
  return { path: 'full_reparse', overlap, aiScore };
}

module.exports = { validateNameDeterministic, computeOverlapScore, resolveNameDecision };