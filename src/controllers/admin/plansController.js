'use strict';

const PlanConfig = require('../../models/PlanConfig');
const { invalidatePlanConfigCache } = require('../../services/subscriptionService');

/**
 * GET /api/admin/plans
 * Retourne la config complète des plans (singleton 'main').
 */
const getPlans = async (req, res) => {
  try {
    const config = await PlanConfig.findOne({ key: 'main' }).lean();
    if (!config) {
      return res.status(404).json({ error: 'PlanConfig non initialisée — lancez seedPlanConfig.js' });
    }
    res.json(config);
  } catch (err) {
    console.error('[admin:plans:get]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * PATCH /api/admin/plans/:plan
 * :plan = 'pro' | 'premium' | 'trial' | 'packs' | 'discounts'
 *
 * Garde-fou quota (pro/premium uniquement) :
 *   - hausse de scansPerMonth → appliquée immédiatement
 *   - baisse de scansPerMonth → mise en pending jusqu'au 1er du mois suivant
 */
const updatePlan = async (req, res) => {
  const { plan } = req.params;
  const allowed = ['pro', 'premium', 'trial', 'packs', 'discounts'];

  if (!allowed.includes(plan)) {
    return res.status(400).json({ error: `Section invalide. Valeurs acceptées : ${allowed.join(', ')}` });
  }

  try {
    const config = await PlanConfig.findOne({ key: 'main' });
    if (!config) {
      return res.status(404).json({ error: 'PlanConfig non initialisée' });
    }

    if (plan === 'pro' || plan === 'premium') {
      await applyPlanEntryUpdate(config, plan, req.body, req.adminId);
    } else if (plan === 'trial') {
      const { days, scans } = req.body;
      if (days !== undefined) config.trial.days  = days;
      if (scans !== undefined) config.trial.scans = scans;
      config.updatedBy = req.adminId;
    } else if (plan === 'packs') {
      // Remplace entièrement le tableau des packs
      config.packs    = req.body.packs ?? config.packs;
      config.updatedBy = req.adminId;
    } else if (plan === 'discounts') {
      const { monthlyMultiplier, quarterlyMultiplier, semiannualMultiplier, annualMultiplier } = req.body;
      if (monthlyMultiplier    !== undefined) config.discounts.monthlyMultiplier    = monthlyMultiplier;
      if (quarterlyMultiplier  !== undefined) config.discounts.quarterlyMultiplier  = quarterlyMultiplier;
      if (semiannualMultiplier !== undefined) config.discounts.semiannualMultiplier = semiannualMultiplier;
      if (annualMultiplier     !== undefined) config.discounts.annualMultiplier     = annualMultiplier;
      config.updatedBy = req.adminId;
    }

    await config.save();
    invalidatePlanConfigCache();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[admin:plans:patch]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Applique une mise à jour sur une entrée de plan (pro/premium).
 * Garde-fou : baisse de scansPerMonth → pending jusqu'au 1er du mois suivant.
 */
async function applyPlanEntryUpdate(config, planKey, body, adminId) {
  const entry = config[planKey];
  const { label, scansPerMonth, priceSN, priceML, maxEmployees, features } = body;

  if (label        !== undefined) entry.label        = label;
  if (priceSN      !== undefined) entry.priceSN      = priceSN;
  if (priceML      !== undefined) entry.priceML      = priceML;
  if (maxEmployees !== undefined) entry.maxEmployees = maxEmployees;

  if (features !== null && typeof features === 'object') {
    for (const [k, v] of Object.entries(features)) {
      if (typeof v === 'boolean' && entry.features) entry.features[k] = v;
    }
  }

  if (scansPerMonth !== undefined && scansPerMonth !== entry.scansPerMonth) {
    if (scansPerMonth > entry.scansPerMonth) {
      // Hausse → immédiate, annule tout pending
      entry.scansPerMonth   = scansPerMonth;
      entry.pendingDecrease = null;
    } else {
      // Baisse → diffère au 1er du mois suivant
      const effectiveFrom = firstDayOfNextMonth();
      entry.pendingDecrease = { value: scansPerMonth, effectiveFrom };
      console.log(
        `[admin:plans] Baisse quota ${planKey} (${entry.scansPerMonth} → ${scansPerMonth}) différée au ${effectiveFrom.toISOString().slice(0, 10)}`
      );
    }
  }

  config.updatedBy = adminId;
}

function firstDayOfNextMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

module.exports = { getPlans, updatePlan };
