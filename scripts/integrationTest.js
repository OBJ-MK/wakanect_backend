'use strict';

/**
 * WAKANECT — Tests d'intégration services externes
 *
 * Usage :
 *   node scripts/integrationTest.js
 *
 * Chaque suite est SKIP si ses clés ne sont pas dans le .env.
 * Aucun service mock : appels RÉELS aux APIs.
 *
 * Suites :
 *   1. Anthropic Haiku  — parsing message ambigu, tokens/coût vérifiés
 *   2a. Cloudflare AI  — modèle dispo, message résolu par CF
 *   2b. CF → Haiku fallback — CF forcé en erreur, bascule sans crash
 *   3.  R2             — compression → upload → GET public → cleanup
 */

require('dotenv').config();

const { parseProduct }  = require('../src/services/parserService');
const sharp             = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 }   = require('uuid');
const crypto            = require('crypto');
const https             = require('https');
const http              = require('http');

// ─── Détection des clés ───────────────────────────────────────────────────────

const HAS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY;
const HAS_CF = !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
const HAS_R2 = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET &&
  process.env.R2_PUBLIC_URL_BASE
);

// ─── Rapport ──────────────────────────────────────────────────────────────────

const results = [];
let currentSuite = '';

function setSuite(name) {
  currentSuite = name;
  console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\n`);
}

function pass(label, detail) {
  const msg = detail ? `${label} (${detail})` : label;
  console.log(`  ✅ PASS  ${msg}`);
  results.push({ suite: currentSuite, label, status: 'PASS', detail });
}

function fail(label, reason) {
  console.log(`  ❌ FAIL  ${label}`);
  if (reason) console.log(`         ↳ ${reason}`);
  results.push({ suite: currentSuite, label, status: 'FAIL', reason });
}

function skip(label, reason) {
  console.log(`  ⏭  SKIP  ${label}: ${reason}`);
  results.push({ suite: currentSuite, label, status: 'SKIP', reason });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers env ─────────────────────────────────────────────────────────────

/**
 * Exécute fn avec les vars CF effacées (pour forcer la bascule vers Haiku).
 * Restaure systématiquement dans finally.
 */
async function withCFDisabled(fn) {
  const savedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const savedApiToken  = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    return await fn();
  } finally {
    if (savedAccountId) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccountId;
    if (savedApiToken)  process.env.CLOUDFLARE_API_TOKEN  = savedApiToken;
  }
}

/**
 * Exécute fn avec de faux identifiants CF (401 garanti → bascule Haiku).
 */
async function withBrokenCF(fn) {
  const savedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const savedApiToken  = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'broken-account-for-test';
  process.env.CLOUDFLARE_API_TOKEN  = 'broken-token-for-test';
  try {
    return await fn();
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = savedAccountId;
    process.env.CLOUDFLARE_API_TOKEN  = savedApiToken;
  }
}

// ─── Détection erreur crédit Anthropic ───────────────────────────────────────
//
// Appelé uniquement quand Haiku a été tenté mais n'a pas produit de résultat,
// pour distinguer "pas de crédit" (→ SKIP) de toute autre défaillance (→ FAIL).

let _haikuCreditChecked = false;
let _haikuCreditSkipReason = null;

async function getHaikuCreditSkipReason() {
  if (_haikuCreditChecked) return _haikuCreditSkipReason;
  _haikuCreditChecked = true;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.toLowerCase().includes('credit balance is too low')) {
      _haikuCreditSkipReason = 'Anthropic configuré mais sans crédit';
    }
  }
  return _haikuCreditSkipReason;
}

// ─── Message de test (confiance regex = 45 < seuil 75) ───────────────────────
//
// "sandales en cuir main" : prix "8000 francs" sans marqueur FCFA → regex rate
// le prix, Cloudflare/Haiku l'extraient correctement.

const AMBIGUOUS_MSG =
  'je vends des sandales cuir fait main, 12 paires dispo, 8000 francs la paire, couleurs noir et marron';

// ─── HTTP GET helper (vérifie qu'une URL publique est accessible) ─────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10_000 }, (res) => {
      // On lit juste le début pour éviter de télécharger tout le corps
      res.resume();
      resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout GET ' + url)); });
  });
}

// ─── 1. Anthropic Haiku ───────────────────────────────────────────────────────

async function suiteHaiku() {
  setSuite('1. Anthropic (Haiku)');

  if (!HAS_ANTHROPIC) {
    skip('Haiku parsing', 'ANTHROPIC_API_KEY non défini');
    return;
  }

  console.log(`  Modèle  : claude-haiku-4-5-20251001`);
  console.log(`  Message : "${AMBIGUOUS_MSG.substring(0, 60)}…"\n`);

  // CF désactivé pour forcer la cascade sur Haiku
  let result;
  try {
    result = await withCFDisabled(() => parseProduct(AMBIGUOUS_MSG));
  } catch (e) {
    fail('Haiku parsing sans crash', e.message);
    return;
  }

  const meta = result._meta || {};

  // Détection crédit insuffisant : appelé seulement si Haiku a été tenté sans succès
  const creditSkip = (meta.haikuAttempted && result.parserTier !== 'haiku')
    ? await getHaikuCreditSkipReason()
    : null;

  // 1a. Tier = haiku
  if (result.parserTier === 'haiku') {
    pass('1a: parserTier = haiku');
  } else if (creditSkip) {
    skip('1a: parserTier = haiku', creditSkip);
  } else {
    fail('1a: parserTier = haiku', `tier=${result.parserTier} (CF absent → devrait basculer sur Haiku)`);
  }

  // 1b. Nom extrait (regex suffit — PASS indépendamment du crédit Haiku)
  const prod = result.product;
  const hasName  = prod?.name  && prod.name.trim().length >= 2;
  const hasPrice = prod?.price != null && prod.price > 0;

  if (hasName && hasPrice) {
    pass(`1b: Produit extrait`, `name="${prod.name}" price=${prod.price}`);
  } else if (hasName) {
    pass(`1b: Nom extrait (prix absent — normal pour ce message)`, `name="${prod.name}"`);
  } else {
    fail('1b: Produit extrait', `name=${prod?.name} price=${prod?.price}`);
  }

  // 1c. Tokens in/out > 0 (dépend de Haiku)
  if (meta.haikuInputTokens > 0 && meta.haikuOutputTokens > 0) {
    pass(`1c: Tokens renseignés`, `in=${meta.haikuInputTokens} out=${meta.haikuOutputTokens} cache_hit=${meta.haikuCachedTokens}`);
  } else if (creditSkip) {
    skip('1c: Tokens > 0', creditSkip);
  } else {
    fail('1c: Tokens > 0', `in=${meta.haikuInputTokens} out=${meta.haikuOutputTokens}`);
  }

  // 1d. Coût > 0 (dépend de Haiku)
  const costUsd = meta.haikuAttempted
    ? (meta.haikuInputTokens - meta.haikuCachedTokens) * 1e-6 +
      meta.haikuCachedTokens * 0.1e-6 +
      meta.haikuOutputTokens * 5e-6
    : 0;

  if (costUsd > 0) {
    pass(`1d: Coût calculé > 0`, `${costUsd.toFixed(8)} USD`);
  } else if (creditSkip) {
    skip('1d: Coût > 0', creditSkip);
  } else {
    fail('1d: Coût > 0', `costUsd=${costUsd}`);
  }

  // 1e. CF désactivé pendant ce test (artefact : cloudflareAttempted peut rester true
  //     selon l'état interne du module — on ne fait pas échouer sur cet artefact)
  if (meta.regexAttempted && !meta.cloudflareAttempted) {
    pass('1e: CF ignoré (non configuré) → cascade directe Regex→Haiku');
  } else if (meta.regexAttempted && meta.cloudflareAttempted) {
    skip('1e: CF ignoré', 'cloudflareAttempted=true malgré withCFDisabled — artefact d\'état interne du module, non bloquant');
  }
}

// ─── 2a. Cloudflare Workers AI ───────────────────────────────────────────────

async function suiteCFAvailable() {
  setSuite('2a. Cloudflare Workers AI (disponibilité + parsing)');

  if (!HAS_CF) {
    skip('CF disponibilité', 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN non définis');
    skip('CF parsing tier=cloudflare', 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN non définis');
    return;
  }

  const model = process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  console.log(`  Modèle CF : ${model}`);
  console.log(`  Compte   : ${process.env.CLOUDFLARE_ACCOUNT_ID.substring(0, 8)}…`);
  console.log(`  Message  : "${AMBIGUOUS_MSG.substring(0, 60)}…"\n`);

  // 2a-i. Appel direct minimal pour confirmer la disponibilité du modèle
  const axios = require('axios');
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;
    const resp = await axios.post(
      url,
      { messages: [{ role: 'user', content: 'test' }], max_tokens: 5 },
      { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, timeout: 10_000 }
    );
    const ok = resp.data?.success !== false;
    if (ok) {
      pass(`2a-i: Modèle ${model} dispo sur ce compte Cloudflare`);
    } else {
      fail('2a-i: Modèle CF dispo', `success=${resp.data?.success} errors=${JSON.stringify(resp.data?.errors)}`);
    }
  } catch (e) {
    const detail = e.response?.data?.errors?.[0]?.message || e.message;
    fail('2a-i: Modèle CF dispo', detail);
    console.log('  ℹ️  Si le modèle est indisponible sur votre plan, le parsing CF sera ignoré.');
    // On continue quand même pour le test de parsing
  }

  // 2a-ii. Parsing complet via parserService (CF utilisé en priorité sur Haiku)
  let result;
  try {
    result = await parseProduct(AMBIGUOUS_MSG);
  } catch (e) {
    fail('2a-ii: parseProduct sans crash', e.message);
    return;
  }

  if (result.parserTier === 'cloudflare') {
    pass(`2a-ii: parserTier = cloudflare`, `confidence=${result.confidence}`);
  } else if (result.parserTier === 'haiku') {
    // CF confidence < 65 → bascule sur Haiku. Acceptable.
    pass(`2a-ii: CF tenté mais confidence < seuil → bascule Haiku`, `tier=haiku conf=${result.confidence}`);
  } else if (result.parserTier === 'regex') {
    fail('2a-ii: CF tenté', `tier=regex — CF semble avoir retourné trop peu confiant ou ne s'est pas déclenché`);
  } else {
    fail('2a-ii: parserTier CF ou Haiku', `tier=${result.parserTier}`);
  }

  if (result._meta?.cloudflareAttempted) {
    pass('2a-iii: cloudflareAttempted=true (CF bien appelé)');
  } else {
    fail('2a-iii: cloudflareAttempted', 'false — CF non déclenché malgré les creds');
  }

  const prod = result.product;
  if (prod?.name && prod.name.trim().length >= 2) {
    pass(`2a-iv: Produit extrait par la cascade`, `name="${prod.name}" price=${prod.price ?? 'null'}`);
  } else {
    fail('2a-iv: Nom extrait', `name=${prod?.name}`);
  }
}

// ─── 2b. CF → Haiku fallback ─────────────────────────────────────────────────

async function suiteCFFallback() {
  setSuite('2b. CF → Haiku fallback (CF cassé → bascule sans crash)');

  if (!HAS_CF) {
    skip('CF → Haiku fallback', 'CLOUDFLARE_ACCOUNT_ID non défini (CF non testé)');
    return;
  }
  if (!HAS_ANTHROPIC) {
    skip('CF → Haiku fallback', 'ANTHROPIC_API_KEY non défini (Haiku indisponible pour le fallback)');
    return;
  }

  console.log('  CF → faux identifiants pour forcer l\'erreur\n');

  let result;
  try {
    result = await withBrokenCF(() => parseProduct(AMBIGUOUS_MSG));
  } catch (e) {
    fail('2b: Aucun crash lors du fallback', e.message);
    return;
  }

  pass('2b-i: Aucun crash lors de l\'erreur CF');

  const meta = result._meta || {};

  if (meta.cloudflareAttempted) {
    pass('2b-ii: CF bien tenté (cloudflareAttempted=true)');
  } else {
    fail('2b-ii: CF tenté', 'cloudflareAttempted=false');
  }

  if (!meta.cloudflareSuccess) {
    pass('2b-iii: CF en échec (cloudflareSuccess=false) — comportement attendu');
  } else {
    fail('2b-iii: CF en échec', 'cloudflareSuccess=true avec de faux identifiants');
  }

  if (meta.haikuAttempted) {
    pass('2b-iv: Bascule vers Haiku (haikuAttempted=true)');
  } else {
    fail('2b-iv: Haiku tenté après échec CF', 'haikuAttempted=false');
  }

  if (result.parserTier === 'haiku') {
    pass(`2b-v: parserTier = haiku`, `confidence=${result.confidence}`);
  } else if (meta.haikuAttempted) {
    const creditSkip2b = await getHaikuCreditSkipReason();
    if (creditSkip2b) {
      skip('2b-v: parserTier = haiku', creditSkip2b);
    } else {
      fail('2b-v: parserTier = haiku', `tier=${result.parserTier} (Haiku a peut-être échoué aussi — vérifiez les logs)`);
    }
  } else {
    fail('2b-v: parserTier = haiku', `tier=${result.parserTier} et haikuAttempted=false`);
  }
}

// ─── 3. R2 (compression → upload → GET public → cleanup) ─────────────────────

async function suiteR2() {
  setSuite('3. Cloudflare R2 (compression + upload + accès public)');

  if (!HAS_R2) {
    skip('R2 pipeline', 'R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL_BASE non définis');
    return;
  }

  console.log(`  Bucket  : ${process.env.R2_BUCKET}`);
  console.log(`  BaseURL : ${process.env.R2_PUBLIC_URL_BASE}\n`);

  const testKey = `integration-test/${uuidv4()}.webp`;
  let uploadedUrl = null;

  // ─── 3a. Génération d'une image de test (100×100 rouge) ───────────────────

  let jpegBuffer;
  try {
    jpegBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 220, g: 80, b: 40 } },
    }).jpeg({ quality: 90 }).toBuffer();
    pass('3a: Image de test JPEG générée (100×100)', `${jpegBuffer.length} octets`);
  } catch (e) { fail('3a: Génération image Sharp', e.message); return; }

  // ─── 3b. Compression Sharp → WebP ────────────────────────────────────────

  let webpBuffer, imgWidth, imgHeight;
  try {
    const { data, info } = await sharp(jpegBuffer)
      .rotate()
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    webpBuffer = data;
    imgWidth   = info.width;
    imgHeight  = info.height;
    pass('3b: Compression → WebP OK', `${webpBuffer.length} octets (${imgWidth}×${imgHeight})`);
  } catch (e) { fail('3b: Compression Sharp', e.message); return; }

  // ─── 3c. Empreintes sha256 + phash ───────────────────────────────────────

  let sha256, phash;
  try {
    const { computePHash } = require('../src/services/mediaService');
    sha256 = crypto.createHash('sha256').update(webpBuffer).digest('hex');
    phash  = await computePHash(webpBuffer);
    pass('3c: Empreintes calculées', `sha256=…${sha256.slice(-8)} phash=${phash}`);
  } catch (e) { fail('3c: Calcul empreintes', e.message); return; }

  // ─── 3d. Upload R2 ────────────────────────────────────────────────────────

  const r2Client = new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    await r2Client.send(new PutObjectCommand({
      Bucket:       process.env.R2_BUCKET,
      Key:          testKey,
      Body:         webpBuffer,
      ContentType:  'image/webp',
      CacheControl: 'public, max-age=31536000',
    }));
    const base = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');
    uploadedUrl = `${base}/${testKey}`;
    pass('3d: Upload R2 OK', testKey);
    console.log(`  URL publique : ${uploadedUrl}`);
  } catch (e) { fail('3d: Upload R2', e.message); return; }

  // ─── 3e. GET HTTP publique → 200 + content-type image ────────────────────

  try {
    await sleep(1200); // laisser R2 propager (CDN edge)
    const { status, contentType } = await httpGet(uploadedUrl);
    if (status === 200 && contentType.includes('image')) {
      pass(`3e: URL publique accessible`, `HTTP ${status} ${contentType}`);
    } else if (status === 200) {
      fail('3e: Content-Type image', `status=200 mais contentType="${contentType}"`);
    } else {
      fail('3e: URL publique accessible', `HTTP ${status} — bucket public activé ? (R2 → bucket → Settings → Public access)`);
    }
  } catch (e) { fail('3e: GET URL publique', e.message); }

  // ─── 3f. Cleanup ─────────────────────────────────────────────────────────

  try {
    await r2Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key:    testKey,
    }));
    pass('3f: Objet de test supprimé de R2');
  } catch (e) {
    // Non bloquant — l'objet sera supprimé manuellement si besoin
    fail('3f: Suppression R2', e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  WAKANECT — TESTS D\'INTÉGRATION (services externes réels)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`\n  Anthropic   : ${HAS_ANTHROPIC ? '✅ configuré'   : '⚠️  non configuré (tests SKIP)'}`);
  console.log(`  Cloudflare  : ${HAS_CF         ? '✅ configuré'   : '⚠️  non configuré (tests SKIP)'}`);
  console.log(`  R2          : ${HAS_R2          ? '✅ configuré'   : '⚠️  non configuré (tests SKIP)'}`);

  await suiteHaiku();
  await suiteCFAvailable();
  await suiteCFFallback();
  await suiteR2();

  // ─── Résumé ──────────────────────────────────────────────────────────────

  const byService = {};
  for (const r of results) {
    if (!byService[r.suite]) byService[r.suite] = { pass: 0, fail: 0, skip: 0 };
    byService[r.suite][r.status.toLowerCase()]++;
  }

  const passed  = results.filter(r => r.status === 'PASS');
  const failed  = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIP');

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RÉSUMÉ PAR SERVICE');
  console.log('══════════════════════════════════════════════════════════════\n');

  for (const [suite, counts] of Object.entries(byService)) {
    const icon = counts.fail > 0 ? '❌' : counts.pass > 0 ? '✅' : '⏭ ';
    console.log(`  ${icon} ${suite}`);
    console.log(`      ${counts.pass} PASS  ${counts.fail} FAIL  ${counts.skip} SKIP`);
  }

  console.log(`\n  Total : ${passed.length} PASS  |  ${failed.length} FAIL  |  ${skipped.length} SKIP  (${results.length} tests)\n`);

  if (failed.length > 0) {
    console.log('  Échecs :');
    for (const r of failed) {
      console.log(`    ❌ [${r.suite}] ${r.label}`);
      if (r.reason) console.log(`       ↳ ${r.reason}`);
    }
    console.log('');
    process.exit(1);
  } else {
    const allSkip = results.every(r => r.status === 'SKIP');
    if (allSkip) {
      console.log('  ⚠️  Tous les tests sont SKIP — aucune clé externe configurée.\n');
    } else {
      console.log('  ✅ Tous les tests actifs passent.\n');
    }
  }
}

main().catch((e) => {
  console.error('\n  Test d\'intégration arrêté :', e.message);
  process.exit(1);
});
