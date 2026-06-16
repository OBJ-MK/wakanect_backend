'use strict';

const Merchant = require('../../models/Merchant');
const Order = require('../../models/Order');
const ParsedMessage = require('../../models/ParsedMessage');
const AuditLog = require('../../models/AuditLog');

/**
 * GET /api/admin/employes?q=
 * Liste tous les employés actifs + productsSent, ordersAccepted, lastAction (EC-07).
 */
const listEmployes = async (req, res) => {
  try {
    const { q } = req.query;

    const merchantFilter = { role: { $ne: 'superadmin' }, 'employees.0': { $exists: true } };
    const merchants = await Merchant.find(merchantFilter)
      .select('slug businessName employees')
      .lean();

    // EC-07: agrégations cross-boutiques en parallèle (par téléphone employé)
    const [sentAgg, ordersAgg, lastActionsAgg] = await Promise.all([
      ParsedMessage.aggregate([
        { $match: { 'submittedBy.actorType': 'employee' } },
        { $group: { _id: '$submittedBy.phone', count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $unwind: '$statusHistory' },
        {
          $match: {
            'statusHistory.status': 'confirmed',
            'statusHistory.performedBy.actorType': 'employee',
          },
        },
        { $group: { _id: '$statusHistory.performedBy.phone', count: { $sum: 1 } } },
      ]),
      ParsedMessage.aggregate([
        { $match: { 'submittedBy.actorType': 'employee' } },
        { $sort: { receivedAt: -1 } },
        { $group: { _id: '$submittedBy.phone', lastAt: { $first: '$receivedAt' } } },
      ]),
    ]);

    const sentMap       = Object.fromEntries(sentAgg.map((x) => [x._id, x.count]));
    const ordersMap     = Object.fromEntries(ordersAgg.map((x) => [x._id, x.count]));
    const lastActionMap = Object.fromEntries(lastActionsAgg.map((x) => [x._id, x.lastAt]));

    const rows = [];
    for (const m of merchants) {
      for (const emp of m.employees) {
        if (!emp.active) continue;
        if (q) {
          const lower = q.toLowerCase();
          if (!emp.name.toLowerCase().includes(lower) && !emp.phone.includes(lower)) continue;
        }
        rows.push({
          name:           emp.name,
          phone:          emp.phone,
          slug:           m.slug,
          shopName:       m.businessName,
          permissions:    emp.permissions,
          productsSent:   sentMap[emp.phone]   || 0,
          ordersAccepted: ordersMap[emp.phone] || 0,
          lastAction:     lastActionMap[emp.phone] || emp.createdAt || null,
          createdAt:      emp.createdAt,
        });
      }
    }

    const recent = await AuditLog.find({ authorType: 'employee' })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.json({
      rows,
      recent: recent.map((a) => ({
        author: a.authorName,
        phone:  a.authorPhone,
        action: a.action,
        slug:   a.slug,
        at:     a.createdAt,
      })),
    });
  } catch (err) {
    console.error('[admin:employes]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { listEmployes };
