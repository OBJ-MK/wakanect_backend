'use strict';

const Merchant = require('../models/Merchant');

/**
 * Bloque une action tant que le marchand n'a pas vérifié son numéro WhatsApp.
 *
 * IMPORTANT : n'enforce RIEN tant que WAKANECT_WHATSAPP_NUMBER n'est pas
 * configuré — le flux OTP inversé (envoi du code au numéro Wakanect) est
 * dormant tant que ce numéro n'existe pas (cf. routes/merchants.js:78).
 * Sans ce garde-fou, activer ce middleware bloquerait tous les marchands
 * du pilote actuel, qui n'ont jamais eu l'occasion de vérifier leur numéro.
 *
 * Une fois WAKANECT_WHATSAPP_NUMBER settée en prod, ce middleware s'active
 * automatiquement, sans déploiement supplémentaire.
 */
const requirePhoneVerification = async (req, res, next) => {
  if (!process.env.WAKANECT_WHATSAPP_NUMBER) {
    return next();
  }

  // Le superadmin (sentinel, hors DB) n'a pas de numéro à vérifier.
  if (req.actor?.type === 'admin' || req.actor?.type === 'superadmin') {
    return next();
  }

  try {
    const merchant = await Merchant.findById(req.merchantId).select('phoneVerification').lean();
    if (!merchant) {
      return res.status(404).json({ error: 'Commerçant introuvable' });
    }

    if (!merchant.phoneVerification?.verified) {
      return res.status(403).json({
        error: 'Numéro WhatsApp non vérifié. Envoyez votre code de vérification au numéro Wakanect pour publier des produits.',
        code: 'PHONE_NOT_VERIFIED',
      });
    }

    next();
  } catch (err) {
    console.error('[requirePhoneVerification]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { requirePhoneVerification };