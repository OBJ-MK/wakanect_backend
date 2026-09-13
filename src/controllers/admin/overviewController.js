'use strict';

const {
  parseDateRange,
  getShopCounts,
  getMRR,
  getParsed24h,
  getParsedPerShop,
  getDeepseekCostToday,
  getDeepseekCostMonthProjected,
  getActivitySeries,
  getAlerts,
} = require('../../services/adminStatsService');
const THRESHOLDS = require('../../constants/alertThresholds');

/**
 * GET /api/admin/overview?range=7d|30d|pilot
 */
const getOverview = async (req, res) => {
  try {
    const { since, until } = await parseDateRange(req.query.range);

    const [shops, mrrData, parsed24h, parsedPerShop, deepseekCostTodayUsd, deepseekCostMonthProjUsd, activitySeries, alerts] =
      await Promise.all([
        getShopCounts(),
        getMRR(),
        getParsed24h(),
        getParsedPerShop(since, until),
        getDeepseekCostToday(),
        getDeepseekCostMonthProjected(),
        getActivitySeries(since, until),
        getAlerts(),
      ]);

    const { usdToFcfa } = THRESHOLDS;

    res.json({
      shops,
      mrr:                   mrrData.total,
      parsed24h,
      parsedPerShop,
      deepseekCostToday:     Math.round(deepseekCostTodayUsd * usdToFcfa),
      deepseekCostMonthProj: Math.round(deepseekCostMonthProjUsd * usdToFcfa),
      activitySeries,
      alerts,
    });
  } catch (err) {
    console.error('[admin:overview]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getOverview };