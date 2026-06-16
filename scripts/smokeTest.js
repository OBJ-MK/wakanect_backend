'use strict';

/**
 * WAKANECT — Smoke Test local
 *
 * Prérequis :
 *   1. .env rempli (MONGODB_URI, JWT_SECRET, WHATSAPP_APP_SECRET=dev-smoke-hmac-secret)
 *   2. node scripts/seedDev.js  — données de test en base
 *   3. npm start                — serveur en cours d'exécution sur PORT (défaut 3000)
 *
 * Usage :
 *   node scripts/smokeTest.js
 *
 * Suites de tests :
 *   A. Auth           : login patron + employé, route protégée 401/200
 *   B. Permissions    : action owner-only → 403 ; action permise → OK
 *   C. Commandes      : créer → confirmer (stock--) → annuler (stock++) → payer
 *   D. Quota          : message vers boutique au plafond → held_quota + ParsingEvent quota_exceeded
 *   E. Paywall        : abonnement canceled + endDate futur → action bloquée 403
 *   F. Webhook regex  : POST webhook (HMAC valide) → tier=regex, candidat en file
 *   G. Anti-doublons  : images différentes → pas de flag ; images identiques → flag
 *   H. Config public  : GET /api/config/public sans auth → 200
 *   I. Plans          : pays-aware, country + plans non vides + aucune feature "illimité"
 *   J. Employees CRUD : permissions-catalog, GET, POST, PATCH, DELETE (owner)
 *   K. Stock ignore   : candidat pending_review → POST ignore → status=ignored en DB
 *   L. Subscription   : GET /api/subscription/status → champs requis présents
 */

require('dotenv').config();
const http     = require('http');
const crypto   = require('crypto');
const mongoose = require('mongoose');

// Modèles et services internes (accès direct DB pour assertions)
const Merchant      = require('../src/models/Merchant');
const Subscription  = require('../src/models/Subscription');
const Product       = require('../src/models/Product');
const Order         = require('../src/models/Order');
const ParsedMessage = require('../src/models/ParsedMessage');
const ParsingEvent  = require('../src/models/ParsingEvent');
const { checkDuplicate } = require('../src/services/duplicateService');

const PORT    = process.env.PORT || 3000;
const MONGODB = process.env.MONGODB_URI;

// ─── Rapport PASS/FAIL ────────────────────────────────────────────────────────

const results = [];
let currentSuite = '';

function setSuite(name) {
  currentSuite = name;
  console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 55 - name.length))}\n`);
}

function pass(label) {
  const name = `${currentSuite} / ${label}`;
  console.log(`  ✅ PASS  ${label}`);
  results.push({ name, status: 'PASS' });
}

function fail(label, reason) {
  const name = `${currentSuite} / ${label}`;
  console.log(`  ❌ FAIL  ${label}`);
  if (reason) console.log(`         ↳ ${reason}`);
  results.push({ name, status: 'FAIL', reason });
}

function skip(label, reason) {
  const name = `${currentSuite} / ${label}`;
  console.log(`  ⚠️  SKIP  ${label}: ${reason}`);
  results.push({ name, status: 'SKIP', reason });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiReq(method, path, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...extraHeaders,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { hostname: 'localhost', port: PORT, path, method, headers };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        reject(new Error(`Serveur non joignable sur le port ${PORT} — lancez d'abord: npm start`));
      } else {
        reject(e);
      }
    });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

// ─── Helpers webhook ─────────────────────────────────────────────────────────

function buildWebhookPayload(fromPhone, textBody, msgId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WAKANECT_ENTRY',
      changes: [{
        field: 'messages',
        value: {
          messages: [{
            id:        msgId,
            from:      fromPhone,
            type:      'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text:      { body: textBody },
          }],
        },
      }],
    }],
  };
}

function computeHmacSig(bodyStr, secret) {
  if (!secret) return 'sha256=no-secret-configured';
  return `sha256=${crypto.createHmac('sha256', secret).update(bodyStr).digest('hex')}`;
}

async function postWebhook(payload, secret) {
  const bodyStr = JSON.stringify(payload);
  const sig     = computeHmacSig(bodyStr, secret);
  return apiReq('POST', '/webhook', payload, null, { 'X-Hub-Signature-256': sig });
}

// ─── Fixtures (lues depuis la DB, créées par seedDev) ────────────────────────

const SHOP_SLUG  = 'demo-smoke-boutique';
const SHOP_PHONE = '22394171909';
const SHOP_PWD   = 'modiboKane994';
const EMP_PHONE  = '221780001234';
const EMP_PWD    = 'Emp1234';
const QUOTA_PHONE= '221779999999';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

// ─── SUITE A — Auth ──────────────────────────────────────────────────────────

async function suiteA() {
  setSuite('A. Auth');
  let ownerToken, empToken;

  // A1: Login patron → token + role
  try {
    const r = await apiReq('POST', '/api/auth/login', {
      identifier: SHOP_PHONE,
      password:   SHOP_PWD,
    });
    if (r.status === 200 && r.body.token) {
      ownerToken = r.body.token;
      if (r.body.merchant?.role) {
        pass('A1: Login patron → token + role renvoyé');
      } else {
        fail('A1: Login patron → token + role', `token OK mais role absent: ${JSON.stringify(r.body.merchant)}`);
      }
    } else {
      fail('A1: Login patron', `status=${r.status} — relancez seedDev.js`);
    }
  } catch (e) { fail('A1: Login patron', e.message); }

  // A2: Login employé → token + role merchant
  try {
    const r = await apiReq('POST', '/api/auth/employee/login', {
      boutiqueSlug: SHOP_SLUG,
      phone:        EMP_PHONE,
      password:     EMP_PWD,
    });
    if (r.status === 200 && r.body.token) {
      empToken = r.body.token;
      if (r.body.merchant?.role) {
        pass('A2: Login employé → token + role renvoyé');
      } else {
        fail('A2: Login employé → role', `token OK mais role absent: ${JSON.stringify(r.body.merchant)}`);
      }
    } else {
      fail('A2: Login employé', `status=${r.status}`);
    }
  } catch (e) { fail('A2: Login employé', e.message); }

  // A3: Route protégée sans token → 401
  try {
    const r = await apiReq('GET', '/api/products', null, null);
    if (r.status === 401) {
      pass('A3: Route protégée sans token → 401');
    } else {
      fail('A3: Sans token → 401', `attendu 401, reçu ${r.status}`);
    }
  } catch (e) { fail('A3: Sans token → 401', e.message); }

  // A4: Route protégée avec token → 200
  try {
    const r = await apiReq('GET', '/api/products', null, ownerToken);
    if (r.status === 200) {
      pass('A4: Route protégée avec token → 200');
    } else {
      fail('A4: Avec token → 200', `attendu 200, reçu ${r.status}`);
    }
  } catch (e) { fail('A4: Avec token → 200', e.message); }

  return { ownerToken, empToken };
}

// ─── SUITE B — Permissions ───────────────────────────────────────────────────

async function suiteB(ownerToken, empToken, merchantId) {
  setSuite('B. Permissions');

  if (!empToken) {
    fail('B: (employé non connecté — A2 a échoué)');
    return;
  }

  // B1: Employé tente d'éditer un produit (products.edit requis) → 403
  try {
    const prods = await Product.find({
      merchantId: new mongoose.Types.ObjectId(merchantId),
      isPublished: true,
    }).limit(1).lean();

    if (!prods.length) {
      fail('B1: Employé PATCH produit → 403', 'aucun produit trouvé — relancez seedDev');
      return;
    }

    const r = await apiReq('PATCH', `/api/products/${prods[0]._id}`, { name: 'Modifié hack' }, empToken);
    if (r.status === 403) {
      pass('B1: Employé PATCH produit (products.edit) → 403');
    } else {
      fail('B1: Employé PATCH produit → 403', `attendu 403, reçu ${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('B1: Employé PATCH produit', e.message); }

  // B2: Employé confirme une commande (orders.confirm → autorisé)
  // Crée une commande fraîche pour ce test
  try {
    const prods = await Product.find({
      merchantId: new mongoose.Types.ObjectId(merchantId),
      isPublished: true,
      stock:       { $gte: 1 },
    }).limit(1).lean();

    if (!prods.length) {
      fail('B2: Employé confirme commande', 'aucun produit en stock');
      return;
    }

    const createR = await apiReq('POST', '/api/orders/public', {
      slug:     SHOP_SLUG,
      customer: { name: 'Test Permissions B2', phone: '221700000099' },
      items:    [{ productId: prods[0]._id.toString(), quantity: 1 }],
    });

    if (createR.status !== 201) {
      fail('B2: Employé confirme commande', `création commande échouée: ${createR.status}`);
      return;
    }

    // Récupérer la commande créée
    const listR = await apiReq('GET', '/api/orders?status=pending&limit=20', null, ownerToken);
    const order  = listR.body.orders?.find(o => o.customer_name === 'Test Permissions B2');

    if (!order) {
      fail('B2: Employé confirme commande', 'commande "Test Permissions B2" introuvable');
      return;
    }

    const confirmR = await apiReq('PATCH', `/api/orders/${order.id}/status`,
      { status: 'Confirmée' }, empToken);

    if (confirmR.status === 200) {
      pass('B2: Employé confirme commande (orders.confirm) → 200');
    } else {
      fail('B2: Employé confirme commande', `attendu 200, reçu ${confirmR.status}: ${JSON.stringify(confirmR.body)}`);
    }
  } catch (e) { fail('B2: Employé confirme commande', e.message); }
}

// ─── SUITE C — Cycle commande ────────────────────────────────────────────────

async function suiteC(ownerToken, merchantId) {
  setSuite('C. Commandes (cycle complet)');

  if (!ownerToken) { fail('C: (patron non connecté — A1 a échoué)'); return; }

  let prod, stockBefore, orderId;

  // Choisir un produit avec du stock disponible
  try {
    const prods = await Product.find({
      merchantId: new mongoose.Types.ObjectId(merchantId),
      isPublished: true,
      stock:       { $gte: 3 },
    }).sort({ stock: -1 }).limit(1).lean();

    if (!prods.length) {
      fail('C: Cycle commande', 'aucun produit publié avec stock ≥ 3 — relancez seedDev');
      return;
    }
    prod = prods[0];
    stockBefore = prod.stock;
  } catch (e) { fail('C: Lecture produit', e.message); return; }

  // C1: Créer commande publique → stock inchangé
  try {
    const r = await apiReq('POST', '/api/orders/public', {
      slug:     SHOP_SLUG,
      customer: { name: 'Client Smoke C', phone: '221700000010' },
      items:    [{ productId: prod._id.toString(), quantity: 2 }],
    });

    if (r.status !== 201) {
      fail('C1: Commande créée (public)', `status=${r.status}: ${JSON.stringify(r.body)}`);
      return;
    }

    const prodAfter = await Product.findById(prod._id).lean();
    if (prodAfter.stock === stockBefore) {
      pass('C1: Commande créée → stock inchangé (pending)');
    } else {
      fail('C1: Stock inchangé à la création', `avant=${stockBefore} après=${prodAfter.stock}`);
    }

    // Récupérer l'ID de la commande
    const listR = await apiReq('GET', '/api/orders?status=pending&limit=20', null, ownerToken);
    const order = listR.body.orders?.find(o => o.customer_name === 'Client Smoke C');
    if (!order) {
      fail('C1: Trouver commande', 'commande "Client Smoke C" introuvable après création');
      return;
    }
    orderId = order.id;
  } catch (e) { fail('C1: Commande créée', e.message); return; }

  // C2: Confirmer → stock décrémenté atomiquement
  try {
    const r = await apiReq('PATCH', `/api/orders/${orderId}/status`,
      { status: 'Confirmée' }, ownerToken);

    if (r.status !== 200) {
      fail('C2: Confirmation commande', `status=${r.status}: ${JSON.stringify(r.body)}`);
      return;
    }

    const prodAfter = await Product.findById(prod._id).lean();
    if (prodAfter.stock === stockBefore - 2) {
      pass(`C2: Commande confirmée → stock décrémenté (${stockBefore} → ${prodAfter.stock})`);
    } else {
      fail('C2: Stock décrémenté', `attendu ${stockBefore - 2}, réel ${prodAfter.stock}`);
    }
  } catch (e) { fail('C2: Confirmation commande', e.message); return; }

  // C3: Annuler (depuis confirmed) → stock ré-incrémenté
  try {
    const r = await apiReq('PATCH', `/api/orders/${orderId}/status`,
      { status: 'Annulée' }, ownerToken);

    if (r.status !== 200) {
      fail('C3: Annulation commande', `status=${r.status}: ${JSON.stringify(r.body)}`);
      return;
    }

    const prodAfter = await Product.findById(prod._id).lean();
    if (prodAfter.stock === stockBefore) {
      pass(`C3: Commande annulée → stock restauré (${stockBefore - 2} → ${prodAfter.stock})`);
    } else {
      fail('C3: Stock restauré', `attendu ${stockBefore}, réel ${prodAfter.stock}`);
    }
  } catch (e) { fail('C3: Annulation commande', e.message); return; }

  // C4: Créer une nouvelle commande et la marquer payée
  try {
    const r = await apiReq('POST', '/api/orders/public', {
      slug:     SHOP_SLUG,
      customer: { name: 'Client Paiement C4', phone: '221700000011' },
      items:    [{ productId: prod._id.toString(), quantity: 1 }],
    });

    if (r.status !== 201) {
      fail('C4: Marquer payée', `création échouée: ${r.status}`);
      return;
    }

    const listR = await apiReq('GET', '/api/orders?status=pending&limit=20', null, ownerToken);
    const order = listR.body.orders?.find(o => o.customer_name === 'Client Paiement C4');
    if (!order) {
      fail('C4: Marquer payée', 'commande introuvable');
      return;
    }

    const payR = await apiReq('PATCH', `/api/orders/${order.id}/payment`,
      { payment_status: 'Payée' }, ownerToken);

    if (payR.status === 200 && payR.body.order?.payment_status === 'Payée') {
      pass('C4: Commande marquée payée (payment_status=Payée)');
    } else {
      fail('C4: Marquer payée', `status=${payR.status}: ${JSON.stringify(payR.body)}`);
    }
  } catch (e) { fail('C4: Marquer payée', e.message); }
}

// ─── SUITE D — Quota ─────────────────────────────────────────────────────────

async function suiteD() {
  setSuite('D. Quota (scansCurrentMonth au plafond)');

  let quotaShop;
  try {
    quotaShop = await Merchant.findOne({ whatsappPhone: QUOTA_PHONE }).lean();
    if (!quotaShop) {
      fail('D: Boutique quota-test', 'introuvable — relancez: node scripts/seedDev.js');
      return;
    }
  } catch (e) { fail('D: Lecture boutique quota-test', e.message); return; }

  const msgId = `smoke-quota-${Date.now()}`;
  const wBody = buildWebhookPayload(QUOTA_PHONE, 'Bananes : 50 kg | 500 FCFA', msgId);

  try {
    const r = await postWebhook(wBody, APP_SECRET);
    if (r.status === 200) {
      pass('D0: POST webhook accepté (200)');
    } else {
      fail('D0: Webhook accepté', `status=${r.status}`);
      return;
    }
  } catch (e) { fail('D0: Webhook quota-test', e.message); return; }

  // Attendre traitement asynchrone
  await sleep(1000);

  // D1: ParsedMessage status=held_quota
  try {
    const pm = await ParsedMessage.findOne({
      merchantId: quotaShop._id,
      waMessageId: msgId,
    }).lean();

    if (!pm) {
      fail('D1: ParsedMessage held_quota', 'document introuvable (appSecret manquant ou sender inconnu?)');
    } else if (pm.status === 'held_quota') {
      pass('D1: ParsedMessage status=held_quota');
    } else {
      fail('D1: ParsedMessage held_quota', `status=${pm.status} (attendu: held_quota)`);
    }
  } catch (e) { fail('D1: ParsedMessage held_quota', e.message); }

  // D2: ParsingEvent tierResolved=quota_exceeded
  try {
    const pe = await ParsingEvent.findOne({
      merchantId:   quotaShop._id,
      tierResolved: 'quota_exceeded',
    }).sort({ createdAt: -1 }).lean();

    if (pe) {
      pass('D2: ParsingEvent tierResolved=quota_exceeded');
    } else {
      fail('D2: ParsingEvent quota_exceeded', 'introuvable en DB');
    }
  } catch (e) { fail('D2: ParsingEvent quota_exceeded', e.message); }

  // D3: Aucun appel IA (haikuAttempted=false)
  try {
    const pe = await ParsingEvent.findOne({
      merchantId:   quotaShop._id,
      tierResolved: 'quota_exceeded',
    }).sort({ createdAt: -1 }).lean();

    if (pe && !pe.haikuAttempted && !pe.cloudflareAttempted) {
      pass('D3: Aucun appel IA lors du dépassement de quota');
    } else {
      fail('D3: Aucun appel IA quota', pe
        ? `haiku=${pe.haikuAttempted} cloudflare=${pe.cloudflareAttempted}`
        : 'ParsingEvent introuvable');
    }
  } catch (e) { fail('D3: Aucun appel IA quota', e.message); }
}

// ─── SUITE E — Paywall ───────────────────────────────────────────────────────

async function suiteE(ownerToken, merchantId) {
  setSuite('E. Paywall (abonnement canceled + endDate futur)');

  if (!ownerToken) { fail('E: (patron non connecté — A1 a échoué)'); return; }

  let sub;
  let originalStatus, originalEndDate;

  try {
    sub = await Subscription.findOne({ merchantId: new mongoose.Types.ObjectId(merchantId) })
      .sort({ createdAt: -1 });
    if (!sub) {
      fail('E: Abonnement introuvable', 'relancez seedDev.js');
      return;
    }
    originalStatus  = sub.status;
    originalEndDate = sub.endDate;
  } catch (e) { fail('E: Lecture abonnement', e.message); return; }

  // Passer l'abonnement en 'canceled' avec endDate futur
  try {
    sub.status  = 'canceled';
    sub.endDate = new Date(Date.now() + 30 * 86_400_000); // +30 jours
    await sub.save();
  } catch (e) {
    fail('E: Modification abonnement en canceled', e.message);
    return;
  }

  // Tenter de créer un produit → 403 SUBSCRIPTION_INACTIVE
  try {
    const r = await apiReq('POST', '/api/products',
      { name: 'Produit Paywall', price: 5000, stock: 1 }, ownerToken);

    if (r.status === 403 && r.body.code === 'SUBSCRIPTION_INACTIVE') {
      pass('E1: Action bloquée (canceled + endDate futur) → 403 SUBSCRIPTION_INACTIVE');
    } else {
      fail('E1: Paywall canceled', `attendu 403 SUBSCRIPTION_INACTIVE, reçu ${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('E1: Paywall test', e.message);
  } finally {
    // Restaurer systématiquement l'abonnement
    try {
      sub.status  = originalStatus;
      sub.endDate = originalEndDate;
      await sub.save();
      console.log('  Abonnement restauré → status=' + originalStatus);
    } catch (restoreErr) {
      console.error('  !! ERREUR restauration abonnement:', restoreErr.message);
    }
  }
}

// ─── SUITE F — Parsing regex + HMAC ─────────────────────────────────────────

async function suiteF(ownerToken, merchantId) {
  setSuite('F. Parsing regex (webhook + signature HMAC)');

  if (!ownerToken) { fail('F: (patron non connecté — A1 a échoué)'); return; }

  const msgId   = `smoke-regex-${Date.now()}`;
  const msgText = 'Baskets Nike : 10 pièces | 25000 FCFA'; // confidence 75 → tier regex

  const wBody   = buildWebhookPayload(SHOP_PHONE, msgText, msgId);
  const bodyStr = JSON.stringify(wBody);
  const sig     = computeHmacSig(bodyStr, APP_SECRET);

  // F1: POST webhook avec HMAC valide → 200
  try {
    const r = await apiReq('POST', '/webhook', wBody, null, { 'X-Hub-Signature-256': sig });
    if (r.status === 200) {
      pass('F1: Webhook POST avec HMAC → 200 accepté');
    } else {
      fail('F1: Webhook → 200', `status=${r.status} body=${JSON.stringify(r.body)}`);
      return;
    }
  } catch (e) { fail('F1: POST webhook', e.message); return; }

  // Attendre le traitement asynchrone (parse regex + ParsingEvent)
  await sleep(1200);

  // F2: ParsedMessage créé avec parserTier=regex
  let pm;
  try {
    pm = await ParsedMessage.findOne({
      merchantId: new mongoose.Types.ObjectId(merchantId),
      waMessageId: msgId,
    }).lean();

    if (!pm) {
      fail('F2: ParsedMessage tier=regex', 'document introuvable — vérifiez que SHOP_PHONE est en DB');
    } else if (pm.parserTier === 'regex') {
      pass('F2: ParsedMessage parserTier=regex (aucun appel IA)');
    } else {
      fail('F2: ParsedMessage tier=regex', `tier=${pm.parserTier} conf=${pm.confidence}`);
    }
  } catch (e) { fail('F2: ParsedMessage tier=regex', e.message); }

  // F3: ParsingEvent tierResolved=regex
  try {
    const pe = pm
      ? await ParsingEvent.findOne({ parsedMessageId: pm._id }).lean()
      : null;

    if (pe && pe.tierResolved === 'regex') {
      pass('F3: ParsingEvent tierResolved=regex');
    } else {
      fail('F3: ParsingEvent tierResolved=regex', pe
        ? `tierResolved=${pe.tierResolved}`
        : 'ParsingEvent introuvable');
    }
  } catch (e) { fail('F3: ParsingEvent', e.message); }

  // F4: Aucun appel Cloudflare/Haiku
  try {
    const pe = pm
      ? await ParsingEvent.findOne({ parsedMessageId: pm._id }).lean()
      : null;

    if (pe && !pe.cloudflareAttempted && !pe.haikuAttempted) {
      pass('F4: Aucun appel Cloudflare/Haiku (regex suffisant)');
    } else {
      fail('F4: Aucun appel IA', pe
        ? `cloudflare=${pe.cloudflareAttempted} haiku=${pe.haikuAttempted}`
        : 'ParsingEvent introuvable');
    }
  } catch (e) { fail('F4: Aucun appel IA', e.message); }

  // F5: Candidat en file pending_review
  try {
    if (pm && pm.status === 'pending_review') {
      pass('F5: Candidat en pending_review dans la file');
    } else {
      fail('F5: Candidat pending_review', pm ? `status=${pm.status}` : 'ParsedMessage introuvable');
    }
  } catch (e) { fail('F5: Candidat pending_review', e.message); }

  // F6: HMAC invalide → 401 (seulement si APP_SECRET est défini)
  if (!APP_SECRET) {
    skip('F6: HMAC invalide → 401', 'WHATSAPP_APP_SECRET non défini (vérification HMAC désactivée en dev)');
  } else {
    try {
      const badR = await apiReq('POST', '/webhook', wBody, null,
        { 'X-Hub-Signature-256': 'sha256=mauvaise_signature_invalide' });
      if (badR.status === 401) {
        pass('F6: Signature HMAC invalide → 401');
      } else {
        fail('F6: HMAC invalide → 401', `attendu 401, reçu ${badR.status}`);
      }
    } catch (e) { fail('F6: HMAC invalide → 401', e.message); }
  }
}

// ─── SUITE G — Anti-doublons ─────────────────────────────────────────────────

async function suiteG(merchantId) {
  setSuite('G. Anti-doublons (image-exact vs image-différentes)');

  let shop;
  try {
    shop = await Merchant.findOne({ slug: SHOP_SLUG }).lean();
    if (!shop) { fail('G: Boutique introuvable'); return; }
  } catch (e) { fail('G: Lecture boutique', e.message); return; }

  const MID = new mongoose.Types.ObjectId(merchantId);

  // Empreintes déterministes
  function fp(seed) {
    return {
      sha256: crypto.createHash('sha256').update(`sha256-${seed}`).digest('hex'),
      phash:  crypto.createHash('sha256').update(`phash-${seed}`).digest('hex').slice(0, 16),
    };
  }
  const FP_A = fp('smoke-g-image-A');
  const FP_B = fp('smoke-g-image-B');

  function makeParsedMsg(imageFp) {
    return ParsedMessage.create({
      merchantId:   MID,
      rawMessage:   'Produit Doublon Smoke G : 10 pièces | 5000 FCFA',
      senderPhone:  shop.whatsappPhone,
      receivedAt:   new Date(),
      submittedBy:  { actorType: 'owner', actorId: shop._id, name: shop.ownerName, phone: shop.whatsappPhone },
      product:      { name: 'Produit Doublon Smoke G', price: 5000, quantity: 10, unit: 'pièce', action: 'set_stock' },
      parserTier:   'regex',
      confidence:   90,
      needsReview:  false,
      missingCritical: [],
      status:       'pending_review',
      images: [{
        url:       `https://r2.dev/smoke-g-${imageFp.sha256.slice(0, 8)}.webp`,
        r2Key:     `smoke-g-${imageFp.sha256.slice(0, 8)}.webp`,
        mimeType:  'image/webp',
        isPrimary: true,
        sha256:    imageFp.sha256,
        phash:     imageFp.phash,
      }],
    });
  }

  const created = [];

  // G1: Référence (image A) + Candidat avec image B (différente) → PAS de doublon
  try {
    const pmRef  = await makeParsedMsg(FP_A); // image A
    const pmDiff = await makeParsedMsg(FP_B); // image B (différente)
    created.push(pmRef._id, pmDiff._id);

    await checkDuplicate(pmDiff._id, MID);
    const checked = await ParsedMessage.findById(pmDiff._id).lean();

    if (checked?.duplicateCheck?.isDuplicate === false) {
      pass('G1: Images différentes (phash distinct) → pas de flag doublon');
    } else {
      fail('G1: Images différentes → pas de doublon',
        `isDuplicate=${checked?.duplicateCheck?.isDuplicate} matchedOn=${checked?.duplicateCheck?.matchedOn}`);
    }
  } catch (e) { fail('G1: Images différentes', e.message); }

  // G2: Candidat avec image A (identique à la référence) → flag doublon
  try {
    const pmSame = await makeParsedMsg(FP_A); // même sha256 que pmRef
    created.push(pmSame._id);

    await checkDuplicate(pmSame._id, MID);
    const checked = await ParsedMessage.findById(pmSame._id).lean();

    if (checked?.duplicateCheck?.isDuplicate === true &&
        checked?.duplicateCheck?.matchedOn   === 'image-exact') {
      pass(`G2: sha256 identique → flag duplicateCheck (image-exact, confidence=${checked.duplicateCheck.confidence})`);
    } else {
      fail('G2: Images identiques → flag doublon',
        `isDuplicate=${checked?.duplicateCheck?.isDuplicate} matchedOn=${checked?.duplicateCheck?.matchedOn}`);
    }
  } catch (e) { fail('G2: Images identiques', e.message); }

  // Nettoyage
  try {
    await ParsedMessage.deleteMany({ _id: { $in: created } });
  } catch (e) { console.warn('  Nettoyage G:', e.message); }
}

// ─── SUITE H — Config public ─────────────────────────────────────────────────

async function suiteH() {
  setSuite('H. Config public (sans auth)');

  try {
    const r = await apiReq('GET', '/api/config/public', null, null);
    if (r.status === 200 && typeof r.body?.wakanect_whatsapp_number === 'string') {
      pass('H1: GET /api/config/public → 200, wakanect_whatsapp_number présent');
    } else {
      fail('H1: Config public', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('H1: Config public', e.message); }
}

// ─── SUITE I — Plans (pays-aware) ────────────────────────────────────────────

async function suiteI(ownerToken) {
  setSuite('I. Plans (pays-aware)');

  if (!ownerToken) { fail('I: (patron non connecté — A1 a échoué)'); return; }

  try {
    const r = await apiReq('GET', '/api/plans', null, ownerToken);
    if (r.status !== 200) {
      fail('I1: GET /api/plans → 200', `status=${r.status}: ${JSON.stringify(r.body)}`);
      return;
    }
    pass('I1: GET /api/plans → 200');

    // I2: country présent (SN ou ML selon préfixe du token)
    if (typeof r.body.country === 'string' && r.body.country.length > 0) {
      pass(`I2: country détecté (${r.body.country})`);
    } else {
      fail('I2: country pays-aware', `country=${r.body.country}`);
    }

    // I3: tableau plans non vide (free/pro/premium)
    if (Array.isArray(r.body.plans) && r.body.plans.length >= 3) {
      pass(`I3: ${r.body.plans.length} plans retournés (free/pro/premium)`);
    } else {
      fail('I3: plans non vides', `plans=${JSON.stringify(r.body.plans)}`);
      return;
    }

    // I4: aucune feature ne contient "illimité"
    const allFeatures = r.body.plans.flatMap((p) => p.features || []);
    const illimite    = allFeatures.filter((f) => f.toLowerCase().includes('illimit'));
    if (illimite.length === 0) {
      pass('I4: Aucune feature "illimité" (quota explicite partout)');
    } else {
      fail('I4: Feature "illimité" interdite', `trouvé : ${illimite.join(' | ')}`);
    }
  } catch (e) { fail('I: Plans', e.message); }
}

// ─── SUITE J — Employees CRUD ────────────────────────────────────────────────

const EMP_TEST_PHONE = '221770000099'; // unique, nettoyé après la suite

async function suiteJ(ownerToken, merchantId) {
  setSuite('J. Employees (CRUD owner)');

  if (!ownerToken) { fail('J: (patron non connecté — A1 a échoué)'); return; }

  // J1: GET permissions-catalog (owner ou employé, avant requireOwner)
  try {
    const r = await apiReq('GET', '/api/employees/permissions-catalog', null, ownerToken);
    if (r.status === 200 && Array.isArray(r.body?.permissions) && r.body.permissions.length > 0) {
      pass(`J1: GET /api/employees/permissions-catalog → 200 (${r.body.permissions.length} permissions)`);
    } else {
      fail('J1: permissions-catalog', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('J1: permissions-catalog', e.message); }

  // J2: GET liste employés
  try {
    const r = await apiReq('GET', '/api/employees', null, ownerToken);
    if (r.status === 200 && Array.isArray(r.body?.employees)) {
      pass(`J2: GET /api/employees → 200 (${r.body.employees.length} employé(s))`);
    } else {
      fail('J2: GET employees', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('J2: GET employees', e.message); }

  // Nettoyage préventif : retirer l'employé test d'un éventuel run précédent
  try {
    await Merchant.findByIdAndUpdate(merchantId, {
      $pull: { employees: { phone: EMP_TEST_PHONE } },
    });
  } catch (_) {}

  let empId;

  // J3: POST créer employé
  try {
    const r = await apiReq('POST', '/api/employees', {
      name:        'Smoke Employé J',
      phone:       EMP_TEST_PHONE,
      password:    'SmokePass99!',
      permissions: ['dashboard.view', 'orders.confirm'],
    }, ownerToken);

    if (r.status === 201 && r.body?.employee?.id) {
      empId = r.body.employee.id;
      pass(`J3: POST /api/employees → 201 (id=${empId})`);
    } else {
      fail('J3: POST employee', `status=${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('J3: POST employee', e.message); }

  if (!empId) return;

  // J4: PATCH modifier nom
  try {
    const r = await apiReq('PATCH', `/api/employees/${empId}`, {
      name: 'Smoke Employé J Modifié',
    }, ownerToken);

    if (r.status === 200 && r.body?.employee?.name === 'Smoke Employé J Modifié') {
      pass('J4: PATCH /api/employees/:id → 200, nom mis à jour');
    } else {
      fail('J4: PATCH employee', `status=${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('J4: PATCH employee', e.message); }

  // J5: DELETE soft-delete → success=true
  try {
    const r = await apiReq('DELETE', `/api/employees/${empId}`, null, ownerToken);
    if (r.status === 200 && r.body?.success) {
      pass('J5: DELETE /api/employees/:id → 200 (soft-delete, historique préservé)');
    } else {
      fail('J5: DELETE employee', `status=${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('J5: DELETE employee', e.message); }

  // Nettoyage : retirer l'entrée soft-deleted de la boutique
  try {
    await Merchant.findByIdAndUpdate(merchantId, {
      $pull: { employees: { phone: EMP_TEST_PHONE } },
    });
  } catch (e) { console.warn('  Nettoyage J:', e.message); }
}

// ─── SUITE K — Stock ignore ──────────────────────────────────────────────────

async function suiteK(ownerToken, merchantId) {
  setSuite('K. Stock ignore (candidat → ignoré)');

  if (!ownerToken) { fail('K: (patron non connecté — A1 a échoué)'); return; }

  let pmId;
  let shop;
  try {
    shop = await Merchant.findById(merchantId).lean();
    if (!shop) { fail('K: boutique introuvable'); return; }
  } catch (e) { fail('K: lecture boutique', e.message); return; }

  // Créer directement un candidat pending_review en DB
  try {
    const pm = await ParsedMessage.create({
      merchantId:      new mongoose.Types.ObjectId(merchantId),
      rawMessage:      'Smoke K : bananes 10 kg 500 FCFA',
      senderPhone:     shop.whatsappPhone,
      receivedAt:      new Date(),
      submittedBy:     { actorType: 'owner', actorId: shop._id, name: shop.ownerName, phone: shop.whatsappPhone },
      product:         { name: 'Banane Smoke K', price: 500, quantity: 10, unit: 'kg', action: 'set_stock' },
      parserTier:      'regex',
      confidence:      85,
      needsReview:     false,
      missingCritical: [],
      status:          'pending_review',
      images:          [],
    });
    pmId = pm._id.toString();
  } catch (e) { fail('K: création candidat en DB', e.message); return; }

  // K1: POST /api/stock/ignore/:id → 200 success=true
  try {
    const r = await apiReq('POST', `/api/stock/ignore/${pmId}`, null, ownerToken);
    if (r.status === 200 && r.body?.success) {
      pass('K1: POST /api/stock/ignore/:id → 200 success=true');
    } else {
      fail('K1: ignore candidat', `status=${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('K1: ignore candidat', e.message); }

  // K2: vérifier status=ignored en DB
  try {
    const pm = await ParsedMessage.findById(pmId).lean();
    if (pm?.status === 'ignored') {
      pass('K2: ParsedMessage.status → ignored en DB');
    } else {
      fail('K2: status ignored en DB', `status=${pm?.status}`);
    }
  } catch (e) { fail('K2: DB check ignored', e.message); }

  // Nettoyage
  try {
    await ParsedMessage.deleteOne({ _id: pmId });
  } catch (e) { console.warn('  Nettoyage K:', e.message); }
}

// ─── SUITE L — Subscription status ──────────────────────────────────────────

async function suiteL(ownerToken) {
  setSuite('L. Subscription status');

  if (!ownerToken) { fail('L: (patron non connecté — A1 a échoué)'); return; }

  try {
    const r = await apiReq('GET', '/api/subscription/status', null, ownerToken);
    if (r.status !== 200) {
      fail('L1: GET /api/subscription/status → 200', `status=${r.status}: ${JSON.stringify(r.body)}`);
      return;
    }
    pass('L1: GET /api/subscription/status → 200');

    const { status, plan, scans_quota } = r.body;

    if (typeof status === 'string' && status.length > 0) {
      pass(`L2: status présent (${status})`);
    } else {
      fail('L2: status présent', `reçu: ${status}`);
    }

    if (typeof plan === 'string' && plan.length > 0) {
      pass(`L3: plan présent (${plan})`);
    } else {
      fail('L3: plan présent', `reçu: ${plan}`);
    }

    if (typeof scans_quota === 'number' && scans_quota > 0) {
      pass(`L4: scans_quota présent et > 0 (${scans_quota})`);
    } else {
      fail('L4: scans_quota > 0', `reçu: ${scans_quota}`);
    }
  } catch (e) { fail('L: subscription/status', e.message); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!MONGODB) {
    console.error('\n  MONGODB_URI manquant dans .env — arrêt.\n');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  WAKANECT — SMOKE TEST LOCAL');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Serveur  : http://localhost:${PORT}`);
  console.log(`  HMAC key : ${APP_SECRET ? '***configurée***' : 'non définie (vérification désactivée)'}`);
  console.log('  Suites   : A–G (existantes) + H Config + I Plans + J Employees + K Ignore + L Sub');
  console.log('══════════════════════════════════════════════════════════');

  await mongoose.connect(MONGODB, { dbName: 'wakanect' });

  // Suite A — récupère les tokens
  const { ownerToken, empToken } = await suiteA();

  // Récupérer le merchantId de la boutique principale
  let merchantId;
  try {
    const shop = await Merchant.findOne({ slug: SHOP_SLUG }).lean();
    if (!shop) throw new Error('boutique intro uvable en DB — relancez seedDev.js');
    merchantId = shop._id.toString();
  } catch (e) {
    console.error('\n  FATAL:', e.message);
    process.exit(1);
  }

  await suiteB(ownerToken, empToken, merchantId);
  await suiteC(ownerToken, merchantId);
  await suiteD();
  await suiteE(ownerToken, merchantId);
  await suiteF(ownerToken, merchantId);
  await suiteG(merchantId);
  await suiteH();
  await suiteI(ownerToken);
  await suiteJ(ownerToken, merchantId);
  await suiteK(ownerToken, merchantId);
  await suiteL(ownerToken);

  await mongoose.disconnect();

  // ─── Résumé final ──────────────────────────────────────────────────────────

  const passed  = results.filter(r => r.status === 'PASS');
  const failed  = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIP');

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  RÉSUMÉ FINAL');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${r.status.padEnd(4)}  ${r.name}`);
    if (r.status === 'FAIL' && r.reason) {
      console.log(`            ↳ ${r.reason}`);
    }
  }

  console.log(`\n  ${passed.length} PASS  |  ${failed.length} FAIL  |  ${skipped.length} SKIP  (total: ${results.length})\n`);

  if (failed.length === 0) {
    console.log('  ✅ Tous les tests passent — le backend est opérationnel.\n');
    process.exit(0);
  } else {
    console.log(`  ❌ ${failed.length} test(s) en échec.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Smoke test arrêté :', e.message);
  process.exit(1);
});
