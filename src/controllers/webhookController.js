const crypto = require('crypto');
const Merchant = require('../models/Merchant');
const ParsedMessage = require('../models/ParsedMessage');
const { parseProduct, splitIntoProductLines } = require('../services/parserService');
const { acknowledgeStockMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/phone');
const { resolveSenderActor } = require('../utils/actorResolver');

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
  if (message.type !== 'text') {
    console.log(`ℹ  Message type "${message.type}" ignoré`);
    return;
  }

  const senderPhone = normalizePhone(message.from);
  const messageBody = message.text?.body?.trim();
  const waMessageId = message.id;

  if (!messageBody) return;

  // Résolution de l'expéditeur (owner ou employé d'une boutique active)
  const resolved = await resolveSenderActor(senderPhone);
  if (!resolved) {
    console.warn(`  Expéditeur inconnu (${senderPhone}) — ignoré`);
    return;
  }

  const { merchant, actor } = resolved;

  // Découpe le message en lignes produits (STOCK multi-lignes → plusieurs ParsedMessages)
  const productLines = splitIntoProductLines(messageBody);

  for (let i = 0; i < productLines.length; i++) {
    const line = productLines[i];
    // waMessageId unique par ligne : "wamid_xxx" pour un seul produit, "wamid_xxx_1" etc. pour multi
    const lineId = productLines.length > 1 ? `${waMessageId}_${i}` : waMessageId;

    // Idempotence : Meta peut renvoyer le même message
    const existing = await ParsedMessage.findOne({ waMessageId: lineId });
    if (existing) {
      console.log(`ℹ  Message ${lineId} déjà traité — ignoré`);
      continue;
    }

    // Pré-filtre + parsing en cascade
    const parseResult = await parseProduct(line);

    if (parseResult.status === 'skipped') {
      console.log(`[webhook] Pré-filtre skip (${senderPhone}): "${line.substring(0, 60)}"`);
      continue; // scan NON compté
    }

    const submittedBy = {
      actorType: actor.actorType,
      actorId: actor.actorId,
      name: actor.name,
      phone: actor.phone,
    };

    // Persistance dans la file de validation
    await ParsedMessage.create({
      merchantId: merchant._id,
      waMessageId: lineId,
      rawMessage: messageBody, // message original complet (pour la bulle WA)
      senderPhone,
      receivedAt: new Date(parseInt(message.timestamp, 10) * 1000),
      submittedBy,
      product: parseResult.product,
      parserTier: parseResult.parserTier,
      confidence: parseResult.confidence,
      needsReview: parseResult.needsReview,
      missingCritical: parseResult.missingCritical,
      status: 'pending_review',
    });

    // Comptage des scans mensuel (incrémentation atomique avec reset mensuel)
    await incrementScanCount(merchant._id);

    console.log(
      `[webhook] Parse OK | tier=${parseResult.parserTier} conf=${parseResult.confidence}` +
      ` needsReview=${parseResult.needsReview} | merchant=${merchant.slug} | par=${actor.name} (${actor.actorType})`
    );
  }

  // Accusé de réception WhatsApp (une seule fois par message entrant)
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

// ─── Compteur de scans mensuel ─────────────────────────────────────────────────

async function incrementScanCount(merchantId) {
  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  // Opération atomique : reset si nouveau mois, puis incrémente
  await Merchant.findByIdAndUpdate(merchantId, [
    {
      $set: {
        'usage.scansCurrentMonth': {
          $cond: {
            if: { $eq: ['$usage.scansMonth', currentMonth] },
            then: { $add: ['$usage.scansCurrentMonth', 1] },
            else: 1,
          },
        },
        'usage.scansMonth': currentMonth,
      },
    },
  ]);
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
