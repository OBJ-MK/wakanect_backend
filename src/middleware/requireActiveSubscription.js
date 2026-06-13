'use strict';

const Subscription = require('../models/Subscription');

const GRACE_MS = 48 * 3600 * 1000; // 48h après endDate

/**
 * Gate paywall : bloque les routes qui nécessitent un abonnement actif.
 *
 * Règles (spec C) :
 *   - endDate > now                       → accès complet
 *   - now <= endDate + 48h                → grâce : accès complet
 *   - now > endDate + 48h                 → 403 paywall
 *   - aucun abonnement trouvé             → 403
 *
 * Routes NON gateées (toujours accessibles même expiré) :
 *   lectures catalogue, gestion commandes existantes, boutique publique.
 */
const requireActiveSubscription = async (req, res, next) => {
  try {
    const sub = await Subscription.findOne({ merchantId: req.merchantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!sub) {
      return res.status(403).json({
        error: 'Abonnement requis',
        code:  'NO_SUBSCRIPTION',
      });
    }

    const now = Date.now();
    const end = new Date(sub.endDate).getTime();

    // Abonnement valide ou dans la grâce de 48h
    if (now <= end + GRACE_MS) {
      return next();
    }

    return res.status(403).json({
      error:   'Abonnement expiré — renouvelez votre plan pour continuer à scanner et publier des produits.',
      code:    'SUBSCRIPTION_EXPIRED',
      expiredAt: sub.endDate,
    });
  } catch (err) {
    console.error('[requireActiveSubscription]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { requireActiveSubscription };
