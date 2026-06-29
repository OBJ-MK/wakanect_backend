const webpush = require('web-push');
const Merchant = require('../models/Merchant');
const PushSubscription = require('../models/PushSubscription');
const { sendTextMessage } = require('./whatsappService');

// Initialisation VAPID — fait une seule fois au chargement du module
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || `mailto:admin@wakanect.com`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const MS_24H = 24 * 60 * 60 * 1000;

/**
 * Notifie tous les abonnés Web Push de la boutique + WhatsApp si dans la fenêtre 24h.
 * Best-effort : aucune erreur ne propage vers l'appelant.
 */
const notifyNewOrder = async (order) => {
  await Promise.allSettled([
    _sendWebPush(order),
    _sendWhatsApp(order),
  ]);
};

async function _sendWebPush(order) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID non configuré — Web Push ignoré');
    return;
  }

  const subscriptions = await PushSubscription.find({ merchantId: order.merchantId });
  if (!subscriptions.length) return;

  const payload = JSON.stringify({
    title: 'Nouvelle commande',
    body: `${order.orderNumber} — ${order.customer.name} — ${order.totalAmount.toLocaleString('fr-FR')} FCFA`,
    data: { url: `/app/commandes/${order._id}`, type: 'order', orderId: String(order._id) },
  });

  const toDelete = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          toDelete.push(sub._id);
        } else {
          console.error(`[push] Erreur envoi subscription ${sub._id}: ${err.message}`);
        }
      }
    })
  );

  if (toDelete.length) {
    await PushSubscription.deleteMany({ _id: { $in: toDelete } });
    console.log(`[push] ${toDelete.length} subscription(s) expirée(s) supprimée(s)`);
  }
}

async function _sendWhatsApp(order) {
  const merchant = await Merchant.findById(order.merchantId)
    .select('whatsappPhone whatsappPhoneId lastInboundAt')
    .lean();

  if (!merchant?.whatsappPhoneId || !merchant?.whatsappPhone) return;

  const within24h =
    merchant.lastInboundAt &&
    Date.now() - new Date(merchant.lastInboundAt).getTime() < MS_24H;

  if (!within24h) return;

  const msg =
    `Nouvelle commande ${order.orderNumber} — ${order.customer.name}` +
    ` — voir le dashboard : ${process.env.APP_URL}/app/commandes/${order._id}`;

  try {
    await sendTextMessage(merchant.whatsappPhoneId, merchant.whatsappPhone, msg);
  } catch (err) {
    console.error('[whatsapp-notif] Erreur envoi:', err.message);
  }
}

/**
 * Notifie les abonnés Web Push qu'un candidat est en attente de validation.
 * Pas de WhatsApp ici : le commerçant vient d'envoyer le message, l'ack WhatsApp
 * est déjà géré par acknowledgeStockMessage (toujours dans la fenêtre 24h).
 */
const notifyNewCandidate = async (merchantId, parsedMsg) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const subscriptions = await PushSubscription.find({ merchantId });
  if (!subscriptions.length) return;

  const preview = parsedMsg.rawMessage
    ? parsedMsg.rawMessage.slice(0, 80)
    : 'Nouveau produit détecté';

  const payload = JSON.stringify({
    title: 'Produit à valider',
    body: preview,
    data: { url: '/app/validation', type: 'candidate' },
  });

  const toDelete = [];
  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          toDelete.push(sub._id);
        } else {
          console.error(`[push] candidat sub ${sub._id}: ${err.message}`);
        }
      }
    })
  );

  if (toDelete.length) {
    await PushSubscription.deleteMany({ _id: { $in: toDelete } });
    console.log(`[push] ${toDelete.length} subscription(s) expirée(s) supprimée(s)`);
  }
};

module.exports = { notifyNewOrder, notifyNewCandidate };
