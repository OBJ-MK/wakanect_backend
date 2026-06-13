'use strict';

const AuditLog = require('../../models/AuditLog');

/**
 * GET /api/admin/audit?scope=all|admin|employee&cursor=&limit=&slug=
 */
const getAudit = async (req, res) => {
  try {
    const { scope = 'all', slug, cursor, action } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const filter = {};
    if (scope !== 'all') filter.authorType = scope === 'admin' ? 'admin' : 'employee';
    if (slug)   filter.slug = slug;
    if (action) filter.action = { $regex: action, $options: 'i' };
    if (cursor) filter.createdAt = { $lt: new Date(cursor) };

    const entries = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = entries.length > limit;
    const rows = (hasMore ? entries.slice(0, limit) : entries).map((a) => ({
      at:         a.createdAt,
      author:     a.authorName || a.authorPhone || a.authorId,
      authorType: a.authorType,
      action:     a.action,
      target:     a.target,
      slug:       a.slug,
      metadata:   a.metadata,
    }));

    res.json({
      rows,
      nextCursor: hasMore ? entries[limit - 1].createdAt.toISOString() : null,
    });
  } catch (err) {
    console.error('[admin:audit]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAudit };
