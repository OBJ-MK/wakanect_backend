'use strict';

const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { isValidObjectId } = mongoose;
const Merchant = require('../../models/Merchant');
const Subscription = require('../../models/Subscription');
const ParsingEvent = require('../../models/ParsingEvent');
const ParsedMessage = require('../../models/ParsedMessage');
const AuditLog = require('../../models/AuditLog');
const { getActiveSubscription, removeExceededEmployees } = require('../../services/subscriptionService');
const { detectCountryFromPhone } = require('../../constants/pricingGrid');
const THRESHOLDS = require('../../constants/alertThresholds');
const { signImpersonationToken } = require('../../utils/jwt');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findMerchantByIdOrFail(id, res) {
  if (!isValidObjectId(id)) {
    res.status(400).json({ error: 'ID invalide' });
    return null;
  }
  const merchant = await Merchant.findById(id);
  if (!merchant || merchant.role === 'superadmin') {
    res.status(404).json({ error: 'Boutique introuvable' });
    return null;
  }
  return merchant;
}

// EC-03/EC-06: status tristate boutique → ce qu'attend le front
function computeStatus(merchant, sub) {
  if (merchant.isActive === false) return 'suspended';
  if (sub?.status === 'trial' || sub?.status === 'active') return 'active';
  return 'dormant';
}

// EC-06/EC-09: paymentStatus FR depuis sub.status
const SUB_PAYMENT_FR = {
  trial:    'En attente',
  active:   'Payé',
  past_due: 'Impayé',
  canceled: 'Impayé',
};

async function writeAudit(req, action, merchant, metadata = {}) {
  await AuditLog.create({
    authorType:  'admin',
    authorId:    req.adminId,
    authorName:  req.adminName,
    authorPhone: req.adminPhone,
    action,
    target:      merchant._id.toString(),
    merchantId:  merchant._id,
    slug:        merchant.slug,
    metadata,
  });
}

// ─── GET /api/admin/boutiques ──────────────────────────────────────────────────

const listBoutiques = async (req, res) => {
  try {
    const { country, status, q } = req.query;
    // EC-04: mapper 'business' → 'premium' (convention legacy du front admin)
    const plan = req.query.plan === 'business' ? 'premium' : (req.query.plan || '');
    const since30d = new Date(Date.now() - 30 * 86400_000);

    const filter = { role: { $ne: 'superadmin' } };
    if (plan) filter.plan = plan;
    if (q) {
      const safe = escapeRegex(q);
      filter.$or = [
        { businessName: { $regex: safe, $options: 'i' } },
        { slug:         { $regex: safe, $options: 'i' } },
      ];
    }

    const merchants = await Merchant.find(filter)
      .select('slug businessName whatsappPhone plan isActive lastInboundAt usage')
      .lean();

    let rows = merchants;
    if (country) {
      rows = rows.filter((m) => detectCountryFromPhone(m.whatsappPhone) === country.toUpperCase());
    }

    const merchantIds = rows.map((m) => m._id);

    const [subMap, haikuMap] = await Promise.all([
      Subscription.find({ merchantId: { $in: merchantIds }, endDate: { $gt: new Date() } })
        .sort({ createdAt: -1 })
        .lean()
        .then((subs) => {
          const map = {};
          for (const s of subs) {
            const id = s.merchantId.toString();
            if (!map[id]) map[id] = s;
          }
          return map;
        }),
      // EC-02: nombre brut d'appels Haiku sur 30j (on divisera par 30 pour /j)
      ParsingEvent.aggregate([
        { $match: { merchantId: { $in: merchantIds }, createdAt: { $gte: since30d }, haikuAttempted: true } },
        { $group: { _id: '$merchantId', calls: { $sum: 1 } } },
      ]).then((r) => Object.fromEntries(r.map((x) => [x._id.toString(), x.calls]))),
    ]);

    const result = rows
      .map((m) => {
        const sub = subMap[m._id.toString()];
        // EC-03: status tristate
        const displayStatus = computeStatus(m, sub);
        if (status && displayStatus !== status) return null;

        return {
          slug:         m.slug,
          name:         m.businessName,
          country:      detectCountryFromPhone(m.whatsappPhone),
          plan:         m.plan,
          status:       displayStatus,
          products:     m.usage?.scansCurrentMonth || 0,
          // EC-02: appels Haiku / jour (moyenne 30j)
          haikuUsage:   Math.round((haikuMap[m._id.toString()] || 0) / 30),
          lastActivity: m.lastInboundAt || null,
        };
      })
      .filter(Boolean);

    res.json({ rows: result });
  } catch (err) {
    console.error('[admin:boutiques:list]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── GET /api/admin/boutiques/:slug ───────────────────────────────────────────

const getBoutique = async (req, res) => {
  try {
    const merchant = await Merchant.findOne({ slug: req.params.slug, role: { $ne: 'superadmin' } }).lean();
    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    const since30d = new Date(Date.now() - 30 * 86400_000);

    const [sub, haikuStats, productsSentByEmp] = await Promise.all([
      getActiveSubscription(merchant._id),
      ParsingEvent.aggregate([
        { $match: { merchantId: merchant._id, createdAt: { $gte: since30d } } },
        {
          $group: {
            _id: null,
            totalEvents:  { $sum: 1 },
            haikuCalls:   { $sum: { $cond: ['$haikuAttempted', 1, 0] } },
            costUsd:      { $sum: '$costUsd' },
            avgLatencyMs: { $avg: '$latencyMs' },
          },
        },
      ]),
      // EC-06: productsSent par téléphone employé
      ParsedMessage.aggregate([
        { $match: { merchantId: merchant._id, 'submittedBy.actorType': 'employee' } },
        { $group: { _id: '$submittedBy.phone', count: { $sum: 1 } } },
      ]),
    ]);

    const h = haikuStats[0] || { totalEvents: 0, haikuCalls: 0, costUsd: 0, avgLatencyMs: 0 };
    const sentMap = Object.fromEntries(productsSentByEmp.map((x) => [x._id, x.count]));
    const status = computeStatus(merchant, sub);

    // EC-05: réponse aplatie — le front fait `const boutique = data`
    res.json({
      id:            merchant._id,
      slug:          merchant.slug,
      name:          merchant.businessName,
      ownerName:     merchant.ownerName,
      email:         merchant.email,
      whatsappPhone: merchant.whatsappPhone,
      country:       detectCountryFromPhone(merchant.whatsappPhone),
      plan:          merchant.plan,
      status,
      createdAt:     merchant.createdAt,
      lastInboundAt: merchant.lastInboundAt,
      products:      merchant.usage?.scansCurrentMonth || 0,

      authorizedNumbers: [
        merchant.whatsappPhone,
        ...merchant.employees.filter((e) => e.active).map((e) => e.phone),
      ],

      employees: merchant.employees.map((e) => ({
        id:           e._id,
        name:         e.name,
        phone:        e.phone,
        active:       e.active,
        permissions:  e.permissions,
        productsSent: sentMap[e.phone] || 0,
        createdAt:    e.createdAt,
      })),

      subscription: sub ? {
        plan:          sub.plan,
        period:        sub.period,
        country:       sub.country,
        status:        sub.status,
        startDate:     sub.startDate,
        endDate:       sub.endDate,
        renewal:       sub.endDate,                               // EC-06: alias attendu par le front
        paymentStatus: SUB_PAYMENT_FR[sub.status] || 'En attente', // EC-06
        amountFcfa:    sub.amountFcfa,
      } : null,

      stats: {
        haikuPerDay:    Math.round((h.haikuCalls || 0) / 30), // EC-06: était haikuCalls30d
        totalEvents30d: h.totalEvents,
        costFcfa30d:    Math.round((h.costUsd || 0) * THRESHOLDS.usdToFcfa),
        avgLatencyMs:   Math.round(h.avgLatencyMs || 0),
      },
    });
  } catch (err) {
    console.error('[admin:boutiques:get]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── Actions ──────────────────────────────────────────────────────────────────

const suspendBoutique = async (req, res) => {
  try {
    const merchant = await findMerchantByIdOrFail(req.params.id, res);
    if (!merchant) return;

    merchant.isActive = false;
    await merchant.save();
    await writeAudit(req, 'suspend', merchant);

    res.json({ success: true });
  } catch (err) {
    console.error('[admin:boutiques:suspend]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const extendTrial = async (req, res) => {
  try {
    const { days = 7 } = req.body;
    const merchant = await findMerchantByIdOrFail(req.params.id, res);
    if (!merchant) return;

    const sub = await Subscription.findOne({ merchantId: merchant._id, status: 'trial' }).sort({ createdAt: -1 });
    if (!sub) return res.status(404).json({ error: 'Aucun essai actif' });

    const previousEnd = sub.endDate;
    sub.endDate = new Date(Math.max(sub.endDate.getTime(), Date.now()) + days * 86400_000);
    await sub.save();

    await writeAudit(req, 'extend-trial', merchant, { days, previousEnd, newEnd: sub.endDate });
    res.json({ success: true, newEndDate: sub.endDate });
  } catch (err) {
    console.error('[admin:boutiques:extend-trial]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const changePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'pro', 'premium'].includes(plan)) {
      return res.status(400).json({ error: 'Plan invalide' });
    }

    const merchant = await findMerchantByIdOrFail(req.params.id, res);
    if (!merchant) return;

    const previousPlan = merchant.plan;
    merchant.plan = plan;
    await merchant.save();

    await Subscription.findOneAndUpdate(
      { merchantId: merchant._id, status: { $in: ['trial', 'active'] }, endDate: { $gt: new Date() } },
      { plan },
      { sort: { createdAt: -1 } }
    );

    // Grandfather : supprime les employés actifs qui dépassent la nouvelle limite
    const grandfatherResult = await removeExceededEmployees(merchant._id, plan);

    await writeAudit(req, 'change-plan', merchant, { previousPlan, newPlan: plan, grandfatherResult });
    res.json({ success: true, grandfatherResult });
  } catch (err) {
    console.error('[admin:boutiques:change-plan]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
    }

    const merchant = await findMerchantByIdOrFail(req.params.id, res);
    if (!merchant) return;

    merchant.passwordHash = await bcrypt.hash(newPassword, 12);
    await merchant.save();

    await writeAudit(req, 'reset-password', merchant);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin:boutiques:reset-password]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const impersonate = async (req, res) => {
  try {
    const merchant = await findMerchantByIdOrFail(req.params.id, res);
    if (!merchant) return;

    const token = signImpersonationToken(merchant, req.adminId);

    await writeAudit(req, 'impersonate', merchant);

    res.json({
      token,
      merchant: {
        id:           merchant._id,
        slug:         merchant.slug,
        businessName: merchant.businessName,
      },
    });
  } catch (err) {
    console.error('[admin:boutiques:impersonate]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { listBoutiques, getBoutique, suspendBoutique, extendTrial, changePlan, resetPassword, impersonate };
