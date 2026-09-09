'use strict';

const AnalyticsEvent = require('../models/AnalyticsEvent');
const DailyStats      = require('../models/DailyStats');
const Merchant         = require('../models/Merchant');

const VALID_EVENTS = ['page_view', 'product_view', 'add_to_cart', 'checkout_started', 'order_placed'];

const STATS_FIELD = {
  page_view:        'pageViews',
  product_view:      'productViews',
  add_to_cart:       'addToCarts',
  checkout_started:  'checkoutsStarted',
  order_placed:      'ordersPlaced',
};

/**
 * POST /api/track
 * Pixel de tracking public (pas d'auth). Ne doit JAMAIS faire échouer l'UX
 * client — toujours 204, même en cas d'erreur interne (log seulement).
 */
const trackEvent = async (req, res) => {
  try {
    const { slug, eventType, productId, orderId, sessionId } = req.body;

    if (!slug || !VALID_EVENTS.includes(eventType)) {
      return res.status(204).end(); // requête malformée — on ignore silencieusement, c'est un pixel
    }

    const merchant = await Merchant.findOne({ slug }, '_id').lean();
    if (!merchant) return res.status(204).end();

    const today = new Date().toISOString().slice(0, 10);

    await Promise.all([
      AnalyticsEvent.create({
        merchantId: merchant._id,
        eventType,
        ...(productId ? { productId } : {}),
        ...(orderId   ? { orderId }   : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
      DailyStats.findOneAndUpdate(
        { merchantId: merchant._id, date: today },
        { $inc: { [STATS_FIELD[eventType]]: 1 } },
        { upsert: true }
      ),
    ]);

    res.status(204).end();
  } catch (err) {
    console.error('[trackEvent]', err.message);
    res.status(204).end(); // idem — le pixel ne casse jamais l'UX
  }
};

module.exports = { trackEvent };