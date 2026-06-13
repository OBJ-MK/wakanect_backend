'use strict';

const ParsingEvent = require('../../models/ParsingEvent');
const AuditLog = require('../../models/AuditLog');
const ParsedMessage = require('../../models/ParsedMessage');

/**
 * GET /api/admin/sante
 * Tableau de bord de santé opérationnelle.
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
      // Approximation : events parsés = messages reçus par le webhook
      ParsingEvent.countDocuments({ createdAt: { $gte: since24h } }),

      // Taux d'erreur Haiku : haiku tenté mais tierResolved != 'haiku'
      ParsingEvent.countDocuments({
        createdAt: { $gte: since24h },
        haikuAttempted: true,
        tierResolved: { $in: ['regex', 'cloudflare', 'failed'] },
      }),

      // Taux d'erreur Cloudflare : CF tenté mais CF pas résolvant et haiku également tenté
      ParsingEvent.countDocuments({
        createdAt: { $gte: since24h },
        cloudflareAttempted: true,
        cloudflareSuccess: false,
      }),

      // Latence moyenne sur 1h
      ParsingEvent.aggregate([
        { $match: { createdAt: { $gte: since1h } } },
        { $group: { _id: null, avg: { $avg: '$latencyMs' } } },
      ]),

      // File de validation en attente
      ParsedMessage.countDocuments({ status: 'pending_review' }),

      // Total images stockées (approximation)
      ParsedMessage.aggregate([
        { $project: { c: { $size: '$images' } } },
        { $group: { _id: null, total: { $sum: '$c' } } },
      ]),

      // Logs d'erreur récents (dernières 50 actions admin en erreur)
      AuditLog.find({ action: { $regex: /error|fail/i } })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    const haikuTotal = await ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, haikuAttempted: true });
    const cfTotal    = await ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, cloudflareAttempted: true });

    const imgTotal = imageCount[0]?.total || 0;

    res.json({
      webhook: {
        status:          'ok',
        received24h:     webhookEvents24h,
        signatureErrors: 0, // non tracé dans ParsingEvent — placeholder
      },
      parseQueue:   pendingMessages,
      avgLatencyMs: Math.round(avgLatency[0]?.avg || 0),
      r2: {
        images:      imgTotal,
        estimatedMb: Math.round(imgTotal * 0.15),
      },
      errorRates: {
        haiku:      haikuTotal > 0 ? Math.round(haikuErrors / haikuTotal * 100) : 0,
        cloudflare: cfTotal    > 0 ? Math.round(cloudflareErrors / cfTotal * 100) : 0,
        r2:         0, // non tracé ici
        ipn:        0, // à connecter à PayDunya plus tard
      },
      logs: recentErrors.map((a) => ({
        level:   'warning',
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
