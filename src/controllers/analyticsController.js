'use strict';

const AnalyticsEvent = require('../models/AnalyticsEvent');
const DailyStats      = require('../models/DailyStats');
const Merchant         = require('../models/Merchant');

const VALID_EVENTS = ['page_view', 'product_view', 'add_to_cart', 'checkout_started', 'order_placed', 'page_duration'];
const VALID_PAGES  = ['catalogue', 'product', 'checkout', 'confirmation', 'tracking'];
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 min — au-delà, c'est un onglet oublié, pas de l'engagement réel

const STATS_FIELD = {
  page_view:        'pageViews',
  product_view:      'productViews',
  add_to_cart:       'addToCarts',
  checkout_started:  'checkoutsStarted',
  order_placed:      'ordersPlaced',
};

const trackEvent = async (req, res) => {
  try {
    const { slug, eventType, productId, orderId, sessionId, page, durationMs } = req.body;

    if (!slug || !VALID_EVENTS.includes(eventType)) return res.status(204).end();

    if (eventType === 'page_duration') {
      const validDuration = typeof durationMs === 'number' && durationMs >= 500 && durationMs <= MAX_DURATION_MS;
      if (!VALID_PAGES.includes(page) || !validDuration) return res.status(204).end();
    }

    const merchant = await Merchant.findOne({ slug }, '_id').lean();
    if (!merchant) return res.status(204).end();

    const today = new Date().toISOString().slice(0, 10);

    const statsUpdate = eventType === 'page_duration'
      ? { $inc: { [`durationSumMs.${page}`]: durationMs, [`durationCount.${page}`]: 1 } }
      : { $inc: { [STATS_FIELD[eventType]]: 1 } };

    await Promise.all([
      AnalyticsEvent.create({
        merchantId: merchant._id,
        eventType,
        ...(productId ? { productId } : {}),
        ...(orderId   ? { orderId }   : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(eventType === 'page_duration' ? { page, durationMs } : {}),
      }),
      DailyStats.findOneAndUpdate({ merchantId: merchant._id, date: today }, statsUpdate, { upsert: true }),
    ]);

    res.status(204).end();
  } catch (err) {
    console.error('[trackEvent]', err.message);
    res.status(204).end();
  }
};

module.exports = { trackEvent };