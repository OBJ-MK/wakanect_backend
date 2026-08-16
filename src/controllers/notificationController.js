'use strict';

const Notification = require('../models/Notification');

// Un acteur voit les notifications globales à la boutique (actorType null) +
// celles qui lui sont spécifiquement adressées.
function scopeFilter(req) {
  return {
    merchantId: req.merchantId,
    $or: [
      { actorType: null },
      { actorType: req.actor?.type, actorId: req.actor?.id },
    ],
  };
}

/**
 * GET /api/notifications
 */
const getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find(scopeFilter(req))
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      notifications: notifications.map((n) => ({
        id:         n._id.toString(),
        type:       n.type,
        title:      n.title,
        body:       n.body,
        to:         n.to,
        read:       n.read,
        created_at: n.createdAt,
      })),
    });
  } catch (err) {
    console.error('[notifications:list]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * POST /api/notifications/:id/read
 */
const markRead = async (req, res) => {
  try {
    await Notification.updateOne(
      { _id: req.params.id, ...scopeFilter(req) },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[notifications:read]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * POST /api/notifications/read-all
 */
const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { ...scopeFilter(req), read: false },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[notifications:read-all]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getNotifications, markRead, markAllRead };