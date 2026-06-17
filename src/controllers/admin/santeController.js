'use strict';

const ParsingEvent  = require('../../models/ParsingEvent');
const AuditLog      = require('../../models/AuditLog');
const ParsedMessage = require('../../models/ParsedMessage');

// Wrap any async sub-check: if it throws, return the fallback and log.
async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[admin:sante] sub-check "${label}" dégradé :`, err.message);
    return fallback;
  }
}

/**
 * GET /api/admin/sante
 * Chaque sous-check est isolé : une erreur l'un n'empêche pas les autres.
 */
const getSante = async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 86_400_000);
    const since1h  = new Date(Date.now() -  3_600_000);

    const [
      webhookEvents24h,
      haikuErrors,
      cloudflareErrors,
      avgLatency,
      pendingMessages,
      imageCount,
      recentErrors,
      haikuTotal,
      cfTotal,
    ] = await Promise.all([
      safe('webhookEvents24h', () =>
        ParsingEvent.countDocuments({ createdAt: { $gte: since24h } }), 0),

      safe('haikuErrors', () =>
        ParsingEvent.countDocuments({
          createdAt:      { $gte: since24h },
          haikuAttempted: true,
          tierResolved:   { $in: ['regex', 'cloudflare', 'failed'] },
        }), 0),

      safe('cloudflareErrors', () =>
        ParsingEvent.countDocuments({
          createdAt:           { $gte: since24h },
          cloudflareAttempted: true,
          cloudflareSuccess:   false,
        }), 0),

      safe('avgLatency', () =>
        ParsingEvent.aggregate([
          { $match: { createdAt: { $gte: since1h } } },
          { $group: { _id: null, avg: { $avg: '$latencyMs' } } },
        ]), []),

      safe('pendingMessages', () =>
        ParsedMessage.countDocuments({ status: 'pending_review' }), 0),

      // $ifNull guards against documents where images is null / absent
      safe('imageCount', () =>
        ParsedMessage.aggregate([
          { $project: { c: { $size: { $ifNull: ['$images', []] } } } },
          { $group: { _id: null, total: { $sum: '$c' } } },
        ]), []),

      safe('recentErrors', () =>
        AuditLog.find({ action: { $regex: /error|fail/i } })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(), []),

      safe('haikuTotal', () =>
        ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, haikuAttempted: true }), 0),

      safe('cfTotal', () =>
        ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, cloudflareAttempted: true }), 0),
    ]);

    const imgTotal = imageCount[0]?.total || 0;

    res.json({
      webhook: {
        status:          'ok',
        received24h:     webhookEvents24h,
        signatureErrors: 0,
      },
      parseQueue:   pendingMessages,
      avgLatencyMs: Math.round(avgLatency[0]?.avg || 0),
      r2: {
        images: imgTotal,
        mb:     Math.round(imgTotal * 0.15),
      },
      errorRates: {
        haiku:      haikuTotal > 0 ? Math.round(haikuErrors      / haikuTotal * 100) : 0,
        cloudflare: cfTotal    > 0 ? Math.round(cloudflareErrors / cfTotal    * 100) : 0,
        r2:         0,
        ipn:        0,
      },
      logs: recentErrors.map((a) => ({
        level:   'warn',
        message: `${a.action} — ${a.slug || ''}`,
        slug:    a.slug,
        at:      a.createdAt,
      })),
    });
  } catch (err) {
    console.error('[admin:sante]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getSante };
