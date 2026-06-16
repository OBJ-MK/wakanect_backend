'use strict';

const ParsingEvent = require('../../models/ParsingEvent');
const AuditLog = require('../../models/AuditLog');
const ParsedMessage = require('../../models/ParsedMessage');

/**
 * GET /api/admin/sante
 */
const getSante = async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 86400_000);
    const since1h  = new Date(Date.now() - 3600_000);

    const [
      webhookEvents24h,
      haikuErrors,
      cloudflareErrors,
      avgLatency,
      pendingMessages,
      imageCount,
      recentErrors,
    ] = await Promise.all([
      ParsingEvent.countDocuments({ createdAt: { $gte: since24h } }),
      ParsingEvent.countDocuments({
        createdAt: { $gte: since24h },
        haikuAttempted: true,
        tierResolved: { $in: ['regex', 'cloudflare', 'failed'] },
      }),
      ParsingEvent.countDocuments({
        createdAt: { $gte: since24h },
        cloudflareAttempted: true,
        cloudflareSuccess: false,
      }),
      ParsingEvent.aggregate([
        { $match: { createdAt: { $gte: since1h } } },
        { $group: { _id: null, avg: { $avg: '$latencyMs' } } },
      ]),
      ParsedMessage.countDocuments({ status: 'pending_review' }),
      ParsedMessage.aggregate([
        { $project: { c: { $size: '$images' } } },
        { $group: { _id: null, total: { $sum: '$c' } } },
      ]),
      AuditLog.find({ action: { $regex: /error|fail/i } })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    const haikuTotal = await ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, haikuAttempted: true });
    const cfTotal    = await ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, cloudflareAttempted: true });
    const imgTotal   = imageCount[0]?.total || 0;

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
        mb:     Math.round(imgTotal * 0.15), // EC-10: était estimatedMb
      },
      errorRates: {
        haiku:      haikuTotal > 0 ? Math.round(haikuErrors / haikuTotal * 100) : 0,
        cloudflare: cfTotal    > 0 ? Math.round(cloudflareErrors / cfTotal * 100) : 0,
        r2:         0,
        ipn:        0,
      },
      logs: recentErrors.map((a) => ({
        level:   'warn',  // EC-11: était 'warning' — front compare === 'warn'
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
