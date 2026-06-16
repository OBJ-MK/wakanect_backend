const crypto = require('crypto');
const Merchant = require('../models/Merchant');
const ParsedMessage = require('../models/ParsedMessage');
const ParsingEvent = require('../models/ParsingEvent');
const { parseProduct, splitIntoProductLines } = require('../services/parserService');
const { acknowledgeStockMessage } = require('../services/whatsappService');
const { processMedia } = require('../services/mediaService');
const { bufferImage, flushImages, isWithinWindow, WINDOW_MS } = require('../services/imageAssociator');
const { normalizePhone } = require('../utils/phone');
const { resolveSenderActor } = require('../utils/actorResolver');
const { checkAndIncrementScan, isSubscriptionActive } = require('../services/subscriptionService');
const { checkDuplicate } = require('../services/duplicateService');
const { notifyNewCandidate } = require('../services/notificationService');

const MAX_IMAGES_PER_PRODUCT = 10;
// Types médias non-image : ignorer proprement (pas d'erreur)
const IGNORED_TYPES = new Set(['video', 'audio', 'document', 'sticker', 'location', 'contacts', 'reaction']);

// ─── Vérification webhook Meta ─────────────────────────────────────────────────

const verifyWebhook = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(' Webhook Meta vérifié');
    return res.status(200).send(challenge);
  }

  console.warn('  Webhook — token de vérification invalide');
  return res.status(403).json({ error: 'Forbidden' });
};

// ─── Réception des messages entrants ──────────────────────────────────────────

const receiveWebhook = async (req, res) => {
  res.status(200).send('OK'); // réponse immédiate à Meta (< 20s obligatoire)

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        for (const message of change.value?.messages || []) {
          await processIncomingMessage(message);
        }
      }
    }
  } catch (err) {
    console.error(' Erreur traitement webhook:', err.message);
  }
};

// ─── Traitement d'un message individuel ───────────────────────────────────────

const processIncomingMessage = async (message) => {
  const { type, from, id: waMessageId, timestamp } = message;

  // Types ignorés proprement
  if (IGNORED_TYPES.has(type)) {
    console.log(`[webhook] Type "${type}" ignoré (${from})`);
    return;
  }

  const senderPhone = normalizePhone(from);
  const receivedAt  = new Date(parseInt(timestamp, 10) * 1000);

  if (type === 'image') {
    // Traitement asynchrone — ne bloque pas la boucle webhook
    setImmediate(() => processImageMessage(message, senderPhone, receivedAt));
    return;
  }

  if (type === 'text') {
    await processTextMessage(message, senderPhone, waMessageId, receivedAt);
    return;
  }

  console.log(`[webhook] Type non géré : "${type}" — ignoré`);
};

// ─── Traitement message texte ─────────────────────────────────────────────────

const processTextMessage = async (message, senderPhone, waMessageId, receivedAt) => {
  const messageBody = message.text?.body?.trim();
  if (!messageBody) return;

  const resolved = await resolveSenderActor(senderPhone);
  if (!resolved) {
    console.warn(`[webhook] Expéditeur inconnu (${senderPhone}) — ignoré`);
    return;
  }
  const { merchant, actor } = resolved;

  // Gate products.send : les employés sans cette permission sont ignorés proprement
  if (actor.actorType === 'employee') {
    const employee = merchant.employees.id(actor.actorId);
    if (!employee || !employee.permissions.includes('products.send')) {
      console.log(`[webhook] Employé ${actor.name} (${senderPhone}) sans permission products.send — message ignoré`);
      return;
    }
  }

  // Gate abonnement : scanner de nouveaux produits requiert un abonnement actif (grâce 48h incluse)
  const subActive = await isSubscriptionActive(merchant._id);
  if (!subActive) {
    console.log(`[webhook] Abonnement expiré pour ${merchant.slug} — scan ignoré`);
    return;
  }

  // Mise à jour fenêtre 24h pour notifications WhatsApp (fire-and-forget)
  Merchant.findByIdAndUpdate(merchant._id, { lastInboundAt: receivedAt }).exec();

  const productLines = splitIntoProductLines(messageBody);

  const lineIds = productLines.map((_, i) =>
    productLines.length > 1 ? `${waMessageId}_${i}` : waMessageId
  );
  const existingDocs = await ParsedMessage.find({ waMessageId: { $in: lineIds } }).select('waMessageId');
  const processedIds = new Set(existingDocs.map((d) => d.waMessageId));

  // Construit une fois — identique pour toutes les lignes du même message
  const submittedBy = {
    actorType: actor.actorType,
    actorId: actor.actorId,
    name: actor.name,
    phone: actor.phone,
  };

  for (let i = 0; i < productLines.length; i++) {
    const line = productLines[i];
    const lineId = lineIds[i];

    if (processedIds.has(lineId)) {
      console.log(`[webhook] Message ${lineId} déjà traité — ignoré`);
      continue;
    }

    // Gate quota AVANT tout appel IA — évite le coût Haiku si quota dépassé
    const scanResult = await checkAndIncrementScan(merchant._id);
    if (!scanResult.allowed) {
      console.log(`[webhook] Quota scans atteint pour ${merchant.slug} (${scanResult.used}/${scanResult.quota}) — message mis en attente`);
      const heldMsg = await ParsedMessage.create({
        merchantId: merchant._id,
        waMessageId: lineId,
        rawMessage: messageBody,
        senderPhone,
        receivedAt,
        submittedBy,
        status: 'held_quota',
      });
      writeParsingEventQuotaExceeded(merchant, line, heldMsg._id);
      continue;
    }

    const parseResult = await parseProduct(line);

    if (parseResult.status === 'skipped') {
      console.log(`[webhook] Pré-filtre skip (${senderPhone}): "${line.substring(0, 60)}"`);
      continue;
    }

    // Récupère les images bufferisées pour cet expéditeur (envoyées avant le texte)
    const pendingImages = flushImages(senderPhone);

    const parsedMsg = await ParsedMessage.create({
      merchantId: merchant._id,
      waMessageId: lineId,
      rawMessage: messageBody,
      senderPhone,
      receivedAt,
      submittedBy,
      product: parseResult.product,
      parserTier: parseResult.parserTier,
      confidence: parseResult.confidence,
      needsReview: parseResult.needsReview,
      missingCritical: parseResult.missingCritical,
      status: 'pending_review',
      images: pendingImages.map((img, idx) => ({ ...img, isPrimary: idx === 0 })),
    });

    // Instrumentation : écriture du ParsingEvent (non bloquant)
    writeParsingEvent(merchant, line, parseResult, parsedMsg._id);

    // Notifier le dashboard (Web Push) — fire-and-forget, silencieux si VAPID absent
    notifyNewCandidate(merchant._id, parsedMsg).catch((err) =>
      console.error('[push] notifyNewCandidate:', err.message)
    );

    // Détection anti-doublons — fire-and-forget après attachement des images
    setImmediate(() =>
      checkDuplicate(parsedMsg._id, merchant._id).catch(err =>
        console.error('[dedup] checkDuplicate error:', err.message)
      )
    );

    if (pendingImages.length > 0) {
      console.log(`[webhook] ${pendingImages.length} image(s) bufferisée(s) attachée(s) au candidat ${parsedMsg._id}`);
    }

    console.log(
      `[webhook] Parse OK | tier=${parseResult.parserTier} conf=${parseResult.confidence}` +
      ` needsReview=${parseResult.needsReview} | merchant=${merchant.slug} | par=${actor.name} (${actor.actorType})`
    );
  }

  const totalParsed = productLines.length;
  if (totalParsed > 0) {
    await acknowledgeStockMessage(merchant, {
      total: totalParsed,
      matched: 0,
      newProducts: totalParsed,
      unparsed: 0,
    });
  }
};

// ─── Traitement message image ─────────────────────────────────────────────────

const processImageMessage = async (message, senderPhone, receivedAt) => {
  const mediaId  = message.image?.id;
  const caption  = message.image?.caption?.trim() || null;
  const waMessageId = message.id;

  if (!mediaId) return;

  const resolved = await resolveSenderActor(senderPhone);
  if (!resolved) {
    console.warn(`[media] Expéditeur inconnu (${senderPhone}) — image ignorée`);
    return;
  }
  const { merchant, actor } = resolved;

  // Gate products.send : les employés sans cette permission sont ignorés proprement
  if (actor.actorType === 'employee') {
    const employee = merchant.employees.id(actor.actorId);
    if (!employee || !employee.permissions.includes('products.send')) {
      console.log(`[media] Employé ${actor.name} (${senderPhone}) sans permission products.send — image ignorée`);
      return;
    }
  }

  // Gate abonnement : scanner de nouveaux produits requiert un abonnement actif (grâce 48h incluse)
  const subActive = await isSubscriptionActive(merchant._id);
  if (!subActive) {
    console.log(`[media] Abonnement expiré pour ${merchant.slug} — image ignorée`);
    return;
  }

  // Mise à jour fenêtre 24h pour notifications WhatsApp (fire-and-forget)
  Merchant.findByIdAndUpdate(merchant._id, { lastInboundAt: receivedAt }).exec();

  // Idempotence : vérifier si ce mediaId a déjà été traité pour ce commerçant
  const alreadyProcessed = await ParsedMessage.findOne({
    merchantId: merchant._id,
    'images.mediaId': mediaId,
  });
  if (alreadyProcessed) {
    console.log(`[media] mediaId ${mediaId} déjà traité — ignoré`);
    return;
  }

  const submittedBy = {
    actorType: actor.actorType,
    actorId: actor.actorId,
    name: actor.name,
    phone: actor.phone,
  };

  // Si la légende contient un texte produit, on crée d'abord le ParsedMessage
  let parsedMessageId = null;

  if (caption) {
    const existing = await ParsedMessage.findOne({ waMessageId });
    if (!existing) {
      const parseResult = await parseProduct(caption);

      if (parseResult.status !== 'skipped') {
        // Gate quota avant de créer le ParsedMessage depuis la caption
        const scanResult = await checkAndIncrementScan(merchant._id);
        if (!scanResult.allowed) {
          console.log(`[media] Quota scans atteint pour ${merchant.slug} (${scanResult.used}/${scanResult.quota}) — caption ignorée`);
        } else {
          const parsedMsg = await ParsedMessage.create({
            merchantId: merchant._id,
            waMessageId,
            rawMessage: caption,
            senderPhone,
            receivedAt,
            submittedBy,
            product: parseResult.product,
            parserTier: parseResult.parserTier,
            confidence: parseResult.confidence,
            needsReview: parseResult.needsReview,
            missingCritical: parseResult.missingCritical,
            status: 'pending_review',
            images: [],
          });
          parsedMessageId = parsedMsg._id;
          // Instrumentation fire-and-forget
          writeParsingEvent(merchant, caption, parseResult, parsedMsg._id);
          console.log(`[media] ParsedMessage créé depuis caption | merchant=${merchant.slug}`);
        }
      }
    } else {
      parsedMessageId = existing._id;
    }
  }

  // Téléchargement + compression + upload R2
  let imageData;
  try {
    imageData = await processMedia(mediaId, {
      merchantId: merchant._id.toString(),
      parsedMessageId: parsedMessageId?.toString(),
      submittedBy,
      receivedAt,
    });
  } catch (err) {
    if (err.code === 'unsupported_mime') {
      console.log(`[media] ${err.message} — ignoré`);
    } else {
      console.error(`[media] Erreur traitement image ${mediaId}:`, err.message);
    }
    return;
  }

  // Attacher l'image à un ParsedMessage
  if (parsedMessageId) {
    // Image avec caption → on vient de créer le candidat
    await attachImageToParsedMessage(parsedMessageId, imageData);
    return;
  }

  // Image sans caption → cherche le candidat le plus récent du même expéditeur
  const recentCandidate = await ParsedMessage.findOne({
    merchantId: merchant._id,
    senderPhone,
    status: 'pending_review',
    receivedAt: { $gte: new Date(Date.now() - WINDOW_MS) },
  }).sort({ receivedAt: -1 });

  if (recentCandidate) {
    if (recentCandidate.images.length < MAX_IMAGES_PER_PRODUCT) {
      await attachImageToParsedMessage(recentCandidate._id, imageData);
    } else {
      console.log(`[media] Candidat ${recentCandidate._id} a déjà ${MAX_IMAGES_PER_PRODUCT} images — image ignorée`);
    }
  } else {
    // Aucun candidat récent → on bufferise pour l'associer au prochain texte
    bufferImage(senderPhone, imageData);
    console.log(`[media] Image bufferisée pour ${senderPhone} (pas de candidat récent)`);
  }
};

// ─── Instrumentation cascade → ParsingEvent ───────────────────────────────────

function normalizeMeta(meta) {
  return {
    inTokens:     meta.haikuInputTokens  || 0,
    outTokens:    meta.haikuOutputTokens || 0,
    cachedTokens: meta.haikuCachedTokens || 0,
    latencyMs:    meta.latencyMs         || 0,
    regexAttempted:      meta.regexAttempted      || false,
    regexSuccess:        meta.regexSuccess         || false,
    cloudflareAttempted: meta.cloudflareAttempted  || false,
    cloudflareSuccess:   meta.cloudflareSuccess    || false,
    haikuAttempted:      meta.haikuAttempted       || false,
    haikuErrored:        meta.haikuErrored         || false,
  };
}

// costUsd : (in - cached)*1e-6 + cached*0.1e-6 + out*5e-6
function computeHaikuCost(m) {
  if (!m.haikuAttempted) return 0;
  return (m.inTokens - m.cachedTokens) * 1e-6 + m.cachedTokens * 0.1e-6 + m.outTokens * 5e-6;
}

function resolveTier(parseResult, m) {
  if (m.haikuAttempted && m.haikuErrored && (parseResult.missingCritical?.length ?? 0) >= 2) {
    return 'failed';
  }
  return parseResult.parserTier;
}

async function writeParsingEventQuotaExceeded(merchant, messageText, parsedMessageId = null) {
  try {
    await ParsingEvent.create({
      merchantId:           merchant._id,
      boutiqueSlug:         merchant.slug,
      tierResolved:         'quota_exceeded',
      regexAttempted:       false,
      regexSuccess:         false,
      cloudflareAttempted:  false,
      cloudflareSuccess:    false,
      haikuAttempted:       false,
      haikuInputTokens:     0,
      haikuOutputTokens:    0,
      haikuCachedTokens:    0,
      costUsd:              0,
      confidenceScore:      0,
      latencyMs:            0,
      producedValidProduct: false,
      messageLength:        messageText.length,
      errorType:            'quota_exceeded',
      parsedMessageId:      parsedMessageId || null,
    });
  } catch (err) {
    console.error('[webhook] ParsingEvent quota_exceeded write error:', err.message);
  }
}

async function writeParsingEvent(merchant, messageText, parseResult, parsedMessageId = null) {
  try {
    const m = normalizeMeta(parseResult._meta || {});
    const costUsd = computeHaikuCost(m);
    const tierResolved = resolveTier(parseResult, m);

    await ParsingEvent.create({
      merchantId:           merchant._id,
      boutiqueSlug:         merchant.slug,
      tierResolved,
      regexAttempted:       m.regexAttempted,
      regexSuccess:         m.regexSuccess,
      cloudflareAttempted:  m.cloudflareAttempted,
      cloudflareSuccess:    m.cloudflareSuccess,
      haikuAttempted:       m.haikuAttempted,
      haikuInputTokens:     m.inTokens,
      haikuOutputTokens:    m.outTokens,
      haikuCachedTokens:    m.cachedTokens,
      costUsd,
      confidenceScore:      parseResult.confidence || 0,
      latencyMs:            m.latencyMs,
      producedValidProduct: parseResult.missingCritical?.length === 0 && parseResult.product !== null,
      messageLength:        messageText.length,
      errorType:            m.haikuErrored ? 'haiku_error' : null,
      parsedMessageId:      parsedMessageId || null,
    });
  } catch (err) {
    console.error('[webhook] ParsingEvent write error:', err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function attachImageToParsedMessage(parsedMessageId, imageData) {
  const doc = await ParsedMessage.findById(parsedMessageId);
  if (!doc) return;
  if (doc.images.length >= MAX_IMAGES_PER_PRODUCT) return;

  const isPrimary = doc.images.length === 0;
  doc.images.push({ ...imageData, isPrimary });
  await doc.save();
  console.log(`[media] Image attachée au candidat ${parsedMessageId} (isPrimary=${isPrimary})`);

  // Re-lance la détection anti-doublons — l'image est le signal décisif, on
  // réévalue à chaque nouvel attachement (fenêtre 120s post-envoi).
  setImmediate(() =>
    checkDuplicate(parsedMessageId, doc.merchantId).catch(err =>
      console.error('[dedup] checkDuplicate error:', err.message)
    )
  );
}

// ─── Vérification de signature HMAC ──────────────────────────────────────────

const verifySignature = (req, res, next) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error(' WHATSAPP_APP_SECRET absent en production — requête rejetée');
      return res.status(500).json({ error: 'Configuration serveur invalide' });
    }
    console.warn(' WHATSAPP_APP_SECRET non défini — signature non vérifiée (dev)');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return res.status(401).json({ error: 'Signature manquante' });

  const expected = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  if (signature !== expected) {
    console.warn('  Signature webhook invalide');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  next();
};

module.exports = { verifyWebhook, receiveWebhook, verifySignature };
