'use strict';

const {
  parseDateRange,
  getShopCounts,
  getMRR,
  getParsed24h,
  getParsedPerShop,
  getHaikuCostToday,
  getHaikuCostMonthProjected,
  getActivitySeries,
  getAlerts,
} = require('../../services/adminStatsService');
const THRESHOLDS = require('../../constants/alertThresholds');

/**
 * GET /api/admin/overview?range=7d|30d|pilot
 */
const getOverview = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);

    const [shops, mrrData, parsed24h, parsedPerShop, haikuCostTodayUsd, haikuCostMonthProjUsd, activitySeries, alerts] =
      await Promise.all([
        getShopCounts(),
        getMRR(),
        getParsed24h(),
        getParsedPerShop(since),
        getHaikuCostToday(),
        getHaikuCostMonthProjected(),
        getActivitySeries(since),
        getAlerts(),
      ]);

    const { usdToFcfa } = THRESHOLDS;

    res.json({
      shops,
      mrr:                mrrData.total,
      parsed24h,
      parsedPerShop,
      haikuCostToday:     Math.round(haikuCostTodayUsd * usdToFcfa),
      haikuCostMonthProj: Math.round(haikuCostMonthProjUsd * usdToFcfa),
      activitySeries,
      alerts,
    });
  } catch (err) {
    console.error('[admin:overview]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getOverview };
