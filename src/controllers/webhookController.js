const crypto = require('crypto');
const ParsedMessage = require('../models/ParsedMessage');
const { parseStockMessage } = require('../services/parserService');
const { acknowledgeStockMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/phone');
const { resolveSenderActor } = require('../utils/actorResolver');

/**
 * GET /webhook
 * Vérification du webhook par Meta (étape d'inscription)
 */
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(' Webhook Meta vérifié');
    return res.status(200).send(challenge);
  }

  console.warn('  Tentative de vérification webhook avec token invalide');
  return res.status(403).json({ error: 'Forbidden' });
};

/**
 * POST /webhook
 * Réception des messages WhatsApp entrants
 */
const receiveWebhook = async (req, res) => {
  // Répondre 200 immédiatement à Meta (obligatoire < 20s)
  res.status(200).send('OK');

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const messages = change.value?.messages || [];

        for (const message of messages) {
          await processIncomingMessage(message);
        }
      }
    }
  } catch (err) {
    // Ne pas re-throw : on a déjà répondu 200 à Meta
    console.error(' Erreur traitement webhook:', err.message);
  }
};

/**
 * Traitement d'un message entrant individuel
 */
const processIncomingMessage = async (message) => {
  if (message.type !== 'text') {
    console.log(`ℹ  Message type "${message.type}" ignoré (non-texte)`);
    return;
  }

  const rawPhone = message.from;
  const senderPhone = normalizePhone(rawPhone);
  const messageBody = message.text?.body?.trim();
  const waMessageId = message.id;

  if (!messageBody) return;

  console.log(` Message reçu de ${senderPhone}: "${messageBody.substring(0, 80)}..."`);

  // Résoudre l'expéditeur : propriétaire ou employé d'une boutique active
  const resolved = await resolveSenderActor(senderPhone);

  if (!resolved) {
    console.warn(`  Expéditeur inconnu (${senderPhone}) — message ignoré`);
    return;
  }

  const { merchant, actor } = resolved;

  // Éviter les doublons (Meta peut renvoyer le même message)
  const existing = await ParsedMessage.findOne({ waMessageId });
  if (existing) {
    console.log(`ℹ  Message ${waMessageId} déjà traité — ignoré`);
    return;
  }

  // Parser le message
  const parseResult = await parseStockMessage(messageBody, merchant._id);

  // Sauvegarder le résultat avec l'auteur tracé
  await ParsedMessage.create({
    merchantId: merchant._id,
    waMessageId,
    rawMessage: messageBody,
    senderPhone,
    receivedAt: new Date(parseInt(message.timestamp) * 1000),
    parsedItems: parseResult.parsedItems,
    parseError: parseResult.error,
    status: parseResult.valid ? 'pending_review' : 'rejected',
    submittedBy: {
      actorType: actor.actorType,
      actorId: actor.actorId,
      name: actor.name,
      phone: actor.phone,
    },
  });

  console.log(
    parseResult.valid
      ? ` Parsing OK — ${parseResult.summary.total} produits | merchant: ${merchant.slug} | par: ${actor.name} (${actor.actorType})`
      : ` Parsing KO — ${parseResult.error} | merchant: ${merchant.slug}`
  );

  if (parseResult.valid && parseResult.summary) {
    await acknowledgeStockMessage(merchant, parseResult.summary);
  }
};

/**
 * Vérification de signature HMAC (sécurité)
 * À utiliser comme middleware avant receiveWebhook
 */
const verifySignature = (req, res, next) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error(' WHATSAPP_APP_SECRET absent en production — requête rejetée');
      return res.status(500).json({ error: 'Configuration serveur invalide' });
    }
    console.warn(' WHATSAPP_APP_SECRET non défini — signature non vérifiée (dev uniquement)');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).json({ error: 'Signature manquante' });
  }

  const rawBody = req.rawBody;
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex')}`;

  if (signature !== expectedSignature) {
    console.warn('  Signature webhook invalide — requête rejetée');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  next();
};

module.exports = { verifyWebhook, receiveWebhook, verifySignature };
