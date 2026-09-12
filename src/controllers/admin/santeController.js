'use strict';

const axios        = require('axios');
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

/** Requêtes + coût cumulé (déjà calculé à l'écriture, voir webhookController.js) */
async function getProviderUsage(attemptedField, since) {
  const [agg] = await ParsingEvent.aggregate([
    { $match: { [attemptedField]: true, createdAt: { $gte: since } } },
    { $group: { _id: null, requests: { $sum: 1 }, costUsd: { $sum: '$costUsd' } } },
  ]);
  return { requests: agg?.requests || 0, costUsd: Number((agg?.costUsd || 0).toFixed(4)) };
}

/** Solde réel DeepSeek — seul fournisseur de la cascade avec un endpoint de balance simple. */
async function getDeepSeekBalance() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const resp = await axios.get('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 5000,
  });
  const infos = resp.data?.balance_infos || [];
  const usd = infos.find((b) => b.currency === 'USD') || infos[0] || null;
  return {
    isAvailable: resp.data?.is_available ?? null,
    balanceUsd:  usd ? Number(usd.total_balance) : null,
    toppedUpUsd: usd ? Number(usd.topped_up_balance) : null,
    grantedUsd:  usd ? Number(usd.granted_balance) : null,
  };
}

/**
 * GET /api/admin/sante
 * Chaque sous-check est isolé : une erreur l'un n'empêche pas les autres.
 */
const getSante = async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 86_400_000);
    const since1h  = new Date(Date.now() -  3_600_000);
    const sinceMonth = new Date();
    sinceMonth.setDate(1);
    sinceMonth.setHours(0, 0, 0, 0);

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
      deepseekErrors,
      deepseekTotal,
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

      safe('deepseekErrors', () =>
        ParsingEvent.countDocuments({
          createdAt:         { $gte: since24h },
          deepseekAttempted: true,
          tierResolved:      { $in: ['regex', 'cloudflare', 'haiku', 'failed'] },
        }), 0),

      safe('deepseekTotal', () =>
        ParsingEvent.countDocuments({ createdAt: { $gte: since24h }, deepseekAttempted: true }), 0),
    ]);

    const imgTotal = imageCount[0]?.total || 0;

    // ─── Consommation par dépendance (solde réel quand disponible, sinon suivi interne) ───
    const [
      deepseekBalance,
      dsToday, dsMonth,
      cfToday, cfMonth,
      haikuToday, haikuMonth,
    ] = await Promise.all([
      safe('deepseekBalance', getDeepSeekBalance, null),
      safe('dsToday',    () => getProviderUsage('deepseekAttempted',   since24h),    { requests: 0, costUsd: 0 }),
      safe('dsMonth',    () => getProviderUsage('deepseekAttempted',   sinceMonth),  { requests: 0, costUsd: 0 }),
      safe('cfToday',    () => getProviderUsage('cloudflareAttempted', since24h),    { requests: 0, costUsd: 0 }),
      safe('cfMonth',    () => getProviderUsage('cloudflareAttempted', sinceMonth),  { requests: 0, costUsd: 0 }),
      safe('haikuToday', () => getProviderUsage('haikuAttempted',      since24h),    { requests: 0, costUsd: 0 }),
      safe('haikuMonth', () => getProviderUsage('haikuAttempted',      sinceMonth),  { requests: 0, costUsd: 0 }),
    ]);

    const integrations = [
      { name: 'DeepSeek',               ok: !!process.env.DEEPSEEK_API_KEY },
      { name: 'Anthropic (Haiku)',      ok: !!process.env.ANTHROPIC_API_KEY },
      { name: 'Cloudflare Workers AI',  ok: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) },
      { name: 'Cloudflare R2 (images)', ok: !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET) },
      { name: 'WhatsApp / Meta',        ok: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_APP_SECRET) },
      { name: 'VAPID (Web Push)',       ok: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) },
    ];

    res.json({
      integrations,
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
        deepseek:   deepseekTotal > 0 ? Math.round(deepseekErrors  / deepseekTotal * 100) : 0,
        haiku:      haikuTotal    > 0 ? Math.round(haikuErrors     / haikuTotal    * 100) : 0,
        cloudflare: cfTotal       > 0 ? Math.round(cloudflareErrors / cfTotal      * 100) : 0,
        r2:         0,
        ipn:        0,
      },
      usage: {
        deepseek: {
          balanceUsd:    deepseekBalance?.balanceUsd ?? null,
          isAvailable:   deepseekBalance?.isAvailable ?? null,
          requestsToday: dsToday.requests,
          costTodayUsd:  dsToday.costUsd,
          requestsMonth: dsMonth.requests,
          costMonthUsd:  dsMonth.costUsd,
        },
        cloudflare: {
          requestsToday: cfToday.requests,
          requestsMonth: cfMonth.requests,
          note: "Neurons restants non exposés par une API simple — voir dashboard.cloudflare.com pour le chiffre exact (10 000 Neurons/jour gratuits).",
        },
        haiku: {
          requestsToday: haikuToday.requests,
          costTodayUsd:  haikuToday.costUsd,
          requestsMonth: haikuMonth.requests,
          costMonthUsd:  haikuMonth.costUsd,
          note: "Solde en direct nécessite une clé Admin API Anthropic distincte (non configurée). Chiffres ci-dessus = suivi interne.",
        },
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