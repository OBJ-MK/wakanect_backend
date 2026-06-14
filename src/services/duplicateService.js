'use strict';

const ParsedMessage = require('../models/ParsedMessage');
const Product = require('../models/Product');

// ─── Seuils (à calibrer sur le pilote) ────────────────────────────────────────
const PHASH_STRONG   = 5;   // distance Hamming ≤ → doublon certain
const PHASH_NEAR     = 10;  // distance Hamming ≤ → proche (vote majoritaire)
const TEXT_THRESHOLD = 0.9; // Jaccard tokens ≥ + même prix → doublon possible

// ─── Hamming distance entre deux dHash hex 16 chars ───────────────────────────

function hammingDistance(h1, h2) {
  let xor = BigInt('0x' + h1) ^ BigInt('0x' + h2);
  let count = 0;
  while (xor > 0n) { if (xor & 1n) count++; xor >>= 1n; }
  return count;
}

// ─── Similarité Jaccard sur tokens normalisés ─────────────────────────────────

function normalizeTokens(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(normalizeTokens(a));
  const setB = new Set(normalizeTokens(b));
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// ─── Chargement des cibles de comparaison pour la boutique ────────────────────

async function loadTargets(merchantId, excludeId) {
  const [products, candidates] = await Promise.all([
    Product.find({ merchantId }).select('_id name price images').lean(),
    ParsedMessage.find({ merchantId, status: 'pending_review', _id: { $ne: excludeId } })
      .select('_id product images').lean(),
  ]);

  return [
    ...products.map(p => ({
      id: p._id,
      name: p.name,
      price: p.price,
      images: p.images || [],
    })),
    ...candidates.map(c => ({
      id: c._id,
      name: c.product?.name,
      price: c.product?.price,
      images: c.images || [],
    })),
  ];
}

// ─── Écriture du résultat sur le candidat ────────────────────────────────────

async function applyResult(parsedMessageId, result) {
  await ParsedMessage.findByIdAndUpdate(parsedMessageId, { duplicateCheck: result });
  if (result.isDuplicate) {
    console.log(
      `[dedup] ${parsedMessageId} → DOUBLON` +
      ` confidence=${result.confidence}` +
      ` matchedOn=${result.matchedOn}` +
      ` duplicateOf=${result.duplicateOf}`
    );
  }
}

// ─── Algorithme principal ─────────────────────────────────────────────────────

/**
 * Vérifie si le ParsedMessage est un doublon d'un produit existant ou d'un
 * autre candidat en file, dans la même boutique.
 *
 * Priorité décisive : IMAGE > TEXTE
 *   1. sha256 exact          → doublon certain (confidence 1.0)
 *   2. pHash Hamming ≤ seuil → doublon probable (confidence déduite)
 *   3. Candidat avec images mais aucune ne matche → PAS un doublon (règle clé)
 *   4. Repli texte+prix uniquement si le candidat n'a aucune image
 *
 * Toujours scopé par merchantId — jamais cross-boutique.
 */
async function checkDuplicate(parsedMessageId, merchantId) {
  const candidate = await ParsedMessage.findOne({ _id: parsedMessageId, merchantId })
    .select('images product')
    .lean();
  if (!candidate) return;

  const targets = await loadTargets(merchantId, parsedMessageId);

  const noMatch = { isDuplicate: false, confidence: 0, matchedOn: null, duplicateOf: [], checkedAt: new Date() };

  // Images du candidat qui ont au moins une empreinte calculée
  const candImages = (candidate.images || []).filter(img => img.sha256 || img.phash);

  if (candImages.length > 0) {
    // ── 1) MATCH IMAGE EXACT (sha256) ──────────────────────────────────────────
    for (const cImg of candImages) {
      if (!cImg.sha256) continue;
      for (const target of targets) {
        for (const tImg of target.images) {
          if (tImg.sha256 && tImg.sha256 === cImg.sha256) {
            await applyResult(parsedMessageId, {
              isDuplicate: true,
              confidence:  1.0,
              matchedOn:   'image-exact',
              duplicateOf: [target.id],
              checkedAt:   new Date(),
            });
            return;
          }
        }
      }
    }

    // ── 2) MATCH IMAGE PERCEPTUEL (pHash, distance Hamming) ────────────────────
    const phashCandImages = candImages.filter(i => i.phash);
    if (phashCandImages.length > 0) {
      let strongMatches = 0;
      let nearMatches   = 0;
      const matchedIds  = new Set();
      let minDist       = Infinity;

      for (const cImg of phashCandImages) {
        let bestDist = Infinity;
        let bestId   = null;

        for (const target of targets) {
          for (const tImg of target.images) {
            if (!tImg.phash) continue;
            const d = hammingDistance(cImg.phash, tImg.phash);
            if (d < bestDist) { bestDist = d; bestId = target.id; }
          }
        }

        if (bestDist <= PHASH_STRONG) {
          strongMatches++;
          if (bestId) matchedIds.add(bestId.toString());
        } else if (bestDist <= PHASH_NEAR) {
          nearMatches++;
          if (bestId) matchedIds.add(bestId.toString());
        }
        if (bestDist < minDist) minDist = bestDist;
      }

      const byStrong = strongMatches >= 1;
      const byNear   = nearMatches   >= Math.ceil(phashCandImages.length / 2);

      if (byStrong || byNear) {
        // Plus la distance est petite, plus la confidence est haute
        const confidence = parseFloat(Math.max(0.01, 1 - minDist / (PHASH_NEAR + 1)).toFixed(2));
        await applyResult(parsedMessageId, {
          isDuplicate: true,
          confidence,
          matchedOn:   'image-near',
          duplicateOf: [...matchedIds],
          checkedAt:   new Date(),
        });
        return;
      }
    }

    // ── 3) RÈGLE CLÉ : images présentes mais aucune ne matche → PAS un doublon
    await applyResult(parsedMessageId, noMatch);
    return;
  }

  // ── 4) REPLI TEXTE + PRIX (candidat sans images) ───────────────────────────
  // Compare contre TOUS les existants (qu'ils aient des images ou non).
  const candName  = candidate.product?.name  || '';
  const candPrice = candidate.product?.price ?? null;

  for (const target of targets) {
    const sim        = jaccardSimilarity(candName, target.name || '');
    const priceMatch = candPrice == null || target.price == null || candPrice === target.price;

    if (sim >= TEXT_THRESHOLD && priceMatch) {
      await applyResult(parsedMessageId, {
        isDuplicate: true,
        confidence:  parseFloat((sim * 0.7).toFixed(2)), // confiance basse — flagge pour revue
        matchedOn:   'text+price',
        duplicateOf: [target.id],
        checkedAt:   new Date(),
      });
      return;
    }
  }

  await applyResult(parsedMessageId, noMatch);
}

module.exports = { checkDuplicate };
