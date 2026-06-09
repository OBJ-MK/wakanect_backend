const crypto = require('crypto');
const Merchant = require('../models/Merchant');
const ParsedMessage = require('../models/ParsedMessage');
const { parseStockMessage } = require('../services/parserService');
const { acknowledgeStockMessage } = require('../services/whatsappService');

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

    // Vérifier que c'est bien un event WhatsApp
    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const messages = value.messages || [];
        const phoneNumberId = value.metadata?.phone_number_id;

        for (const message of messages) {
          await processIncomingMessage(message, phoneNumberId);
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
const processIncomingMessage = async (message, phoneNumberId) => {
  // On ne traite que les messages texte pour l'instant
  if (message.type !== 'text') {
    console.log(`ℹ  Message type "${message.type}" ignoré (non-texte)`);
    return;
  }

  const senderPhone = message.from;        // numéro de l'expéditeur
  const messageBody = message.text?.body?.trim();
  const waMessageId = message.id;

  if (!messageBody) return;

  console.log(` Message reçu de ${senderPhone}: "${messageBody.substring(0, 80)}..."`);

  // Trouver le commerçant par son Phone Number ID (configuré dans Meta)
  // ou par son numéro d'expéditeur (lui-même)
  const merchant = await Merchant.findOne({
    $or: [
      { whatsappPhoneId: phoneNumberId },
      { whatsappPhone: senderPhone },
    ],
    isActive: true,
  });

  if (!merchant) {
    console.warn(`  Aucun commerçant trouvé pour phone ${senderPhone} / phoneId ${phoneNumberId}`);
    return;
  }

  // Éviter les doublons (Meta peut renvoyer le même message)
  const existing = await ParsedMessage.findOne({ waMessageId });
  if (existing) {
    console.log(`ℹ  Message ${waMessageId} déjà traité — ignoré`);
    return;
  }

  // Parser le message
  const parseResult = await parseStockMessage(messageBody, merchant._id);

  // Sauvegarder le résultat en base (pour la validation dashboard)
  const parsed = await ParsedMessage.create({
    merchantId: merchant._id,
    waMessageId,
    rawMessage: messageBody,
    senderPhone,
    receivedAt: new Date(parseInt(message.timestamp) * 1000),
    parsedItems: parseResult.parsedItems,
    parseError: parseResult.error,
    status: parseResult.valid ? 'pending_review' : 'rejected',
  });

  console.log(
    parseResult.valid
      ? ` Parsing OK — ${parseResult.summary.total} produits | merchant: ${merchant.slug}`
      : ` Parsing KO — ${parseResult.error} | merchant: ${merchant.slug}`
  );

  // Envoyer un accusé de réception au commerçant
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
      // Ne devrait jamais arriver (bloqué au démarrage dans index.js)
      console.error(' WHATSAPP_APP_SECRET absent en production — requête rejetée');
      return res.status(500).json({ error: 'Configuration serveur invalide' });
    }
    // Développement sans secret : skip toléré
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
