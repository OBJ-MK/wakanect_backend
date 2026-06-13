const PushSubscription = require('../models/PushSubscription');

/**
 * GET /api/push/vapid-public-key
 * Retourne la clé publique VAPID nécessaire côté client pour créer une subscription.
 */
const getVapidPublicKey = (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Web Push non configuré sur ce serveur' });
  }
  res.json({ publicKey: key });
};

/**
 * POST /api/push/subscribe
 * Enregistre ou met à jour la subscription push de l'acteur connecté.
 * Body: { subscription: { endpoint, keys: { p256dh, auth } } }
 */
const subscribe = async (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'subscription invalide (endpoint + keys.p256dh + keys.auth requis)' });
    }

    await PushSubscription.findOneAndUpdate(
      { merchantId: req.merchantId, 'subscription.endpoint': subscription.endpoint },
      {
        merchantId: req.merchantId,
        actorType: req.actor.type,
        actorId: req.actor.id,
        subscription,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[push] subscribe:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * POST /api/push/unsubscribe
 * Supprime la subscription push par endpoint.
 * Body: { endpoint }
 */
const unsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint requis' });

    await PushSubscription.deleteOne({
      merchantId: req.merchantId,
      'subscription.endpoint': endpoint,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getVapidPublicKey, subscribe, unsubscribe };
