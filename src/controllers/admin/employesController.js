'use strict';

const Merchant = require('../../models/Merchant');
const Order = require('../../models/Order');
const AuditLog = require('../../models/AuditLog');

/**
 * GET /api/admin/employes?q=
 * Liste tous les employés de toutes les boutiques.
 */
const listEmployes = async (req, res) => {
  try {
    const { q } = req.query;

    const merchantFilter = { role: { $ne: 'superadmin' }, 'employees.0': { $exists: true } };
    const merchants = await Merchant.find(merchantFilter)
      .select('slug businessName employees')
      .lean();

    const rows = [];
    for (const m of merchants) {
      for (const emp of m.employees) {
        if (!emp.active) continue;
        if (q) {
          const lower = q.toLowerCase();
          if (!emp.name.toLowerCase().includes(lower) && !emp.phone.includes(lower)) continue;
        }
        rows.push({
          name:        emp.name,
          phone:       emp.phone,
          slug:        m.slug,
          shopName:    m.businessName,
          permissions: emp.permissions,
          createdAt:   emp.createdAt,
        });
      }
    }

    // Actions récentes des employés dans l'audit
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
