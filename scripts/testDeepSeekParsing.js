'use strict';

/**
 * WAKANECT — Test du schéma en couches sur DeepSeek (pendant que Mistral se débloque)
 *
 * Même principe que testMistralParsing.js : regex extrait prix/quantité/tailles/
 * couleurs → ces indices sont transmis à DeepSeek en plus du texte brut →
 * DeepSeek se concentre sur nom + catégorie. Banc d'essai isolé, ne touche
 * pas parserService.js.
 *
 * Usage :
 *   1. Ajoute DEEPSEEK_API_KEY=xxx à ton .env local (platform.deepseek.com → API Keys)
 *   2. node scripts/testDeepSeekParsing.js
 */

require('dotenv').config();
const axios = require('axios');
const { extractWithRegex } = require('../src/services/parsing');

const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

// Mêmes cas difficiles que pour Mistral — comparaison directe possible.
// À COMPLÉTER avec de vrais messages tirés de ParsedMessage en base pour un
// test représentatif du pilote.
const CORPUS = [
  "🔥🔥 PROMO ! Ensemble jogging gris et noir 12.500f taille L et XL 🔥 Livraison possible sur Dakar",
  "Bonjour à tous, nouvel arrivage de chaussures dames du 37 au 41, très confortables, 9500f",
  "iPhone 13 128Go 350.000f propre, batterie 89%, vient avec chargeur et boîte d'origine",
  "Je vends des mèches brésiliennes 18000f x5 dernières pièces avant rupture de stock",
  "Sac à main cuir véritable, fait main, 12500 reste 3 seulement dépêchez vous",
  "TV Samsung 43 pouces 185000f garantie 1 an livraison gratuite Dakar Pikine",
  "Voile suisse de très bonne qualité, tissu doux, 3 500 CFA le mètre",
  "Montre homme dorée résistante à l'eau 8000fr parfait cadeau",
  "L'ensemble complet dame taille unique 22000f, port compris sur Dakar",
  "2 cartons de savon parfumé importé à 15000 le carton, disponible immédiatement",
];

function buildHintsBlock(regexProduct) {
  const hints = [];
  if (regexProduct.price != null) hints.push(`prix détecté = ${regexProduct.price} FCFA`);
  if (regexProduct.quantity != null) hints.push(`quantité détectée = ${regexProduct.quantity}`);
  if (regexProduct.sizes?.length) hints.push(`tailles détectées = ${regexProduct.sizes.join(', ')}`);
  if (regexProduct.colors?.length) hints.push(`couleurs détectées = ${regexProduct.colors.join(', ')}`);
  return hints.length ? hints.join('\n') : "Aucun champ détecté avec certitude par le premier passage.";
}

const SYSTEM_PROMPT = `Tu es la deuxième passe d'un pipeline d'extraction de produits pour des commerçants ouest-africains sur WhatsApp.

Un premier passage automatique (regex) a déjà tenté d'extraire prix, quantité, tailles et couleurs à partir du texte brut. Ces valeurs sont fiables quand elles sont présentes, mais ce premier passage ne sait PAS déterminer le nom du produit ni sa catégorie — c'est ton rôle principal.

Retourne UNIQUEMENT du JSON valide (aucun texte avant ou après, aucune balise markdown) :
{
  "name": "nom du produit uniquement, sans les phrases hors-sujet du vendeur",
  "price": nombre ou null (FCFA, entier sans séparateurs),
  "quantity": nombre ou 10,
  "unit": "pièce",
  "sizes": [],
  "colors": [],
  "category": "catégorie courte, ex: Vêtements, Chaussures, Cosmétiques, Électronique, Tissus, Accessoires, Autre"
}

Règles :
- Si le premier passage a détecté un champ (voir "Indices du premier passage"), reprends cette valeur sauf si le texte brut la contredit clairement.
- "name" : ignore tout ce qui n'est pas le produit lui-même — salutations, promesses de livraison, état de stock, arguments de vente, emojis.
- En Afrique de l'Ouest le point sépare les milliers : "25.000f" = 25000 FCFA.
- Ne jamais inventer : si un champ n'est pas clair, mets null ou [].`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callDeepSeekRaw(text, regexProduct) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY manquant dans .env');

  const userContent = `Message du commerçant :\n"""${text}"""\n\nIndices du premier passage (regex) :\n${buildHintsBlock(regexProduct)}`;

  const resp = await axios.post(
    DEEPSEEK_URL,
    {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15_000 }
  );

  const raw = resp.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('DeepSeek : réponse vide');
  return JSON.parse(raw);
}

async function callDeepSeek(text, regexProduct, retries = 3, waitMs = 3000) {
  try {
    return await callDeepSeekRaw(text, regexProduct);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    if (status === 429 && retries > 0) {
      console.warn(`  (429 — détail : ${JSON.stringify(body)}) — retry dans ${waitMs / 1000}s...`);
      await delay(waitMs);
      return callDeepSeek(text, regexProduct, retries - 1, waitMs * 2);
    }
    const detail = body ? ` — ${JSON.stringify(body)}` : '';
    throw new Error(`${err.message}${detail}`);
  }
}

async function main() {
  console.log('─'.repeat(70));
  console.log(`Test du schéma en couches (regex → indices → DeepSeek) — modèle: ${DEEPSEEK_MODEL}`);
  console.log('─'.repeat(70));

  for (const text of CORPUS) {
    const regexProduct = extractWithRegex(text);
    let dsProduct;
    try {
      dsProduct = await callDeepSeek(text, regexProduct);
      await delay(500); // marge légère, DeepSeek est nettement moins restrictif que le tier gratuit Mistral
    } catch (err) {
      console.log(`\n✗ "${text}"`);
      console.log(`  Erreur DeepSeek : ${err.message}`);
      continue;
    }

    console.log(`\n"${text}"`);
    console.log(`  regex    → name="${regexProduct.name}" price=${regexProduct.price} qty=${regexProduct.quantity} category=${regexProduct.category}`);
    console.log(`  deepseek → name="${dsProduct.name}" price=${dsProduct.price} qty=${dsProduct.quantity} category=${dsProduct.category}`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log('Relis chaque paire "regex vs deepseek" : deepseek doit corriger le nom/la');
  console.log('catégorie sans jamais changer un prix/quantité/taille/couleur que la');
  console.log('regex avait déjà bien trouvé.');
}

main().catch(err => {
  console.error('Erreur fatale :', err.message);
  process.exit(1);
});