'use strict';

const ParsingEvent = require('../../models/ParsingEvent');
const { parseDateRange, getParsingFunnel, getTopShopsByHaiku } = require('../../services/adminStatsService');

/**
 * GET /api/admin/parsing/funnel?range=
 */
const getFunnel = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);
    const data = await getParsingFunnel(since);
    res.json(data);
  } catch (err) {
    console.error('[admin:parsing:funnel]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * GET /api/admin/parsing/top?range=
 */
const getTop = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);
    const rows = await getTopShopsByHaiku(since);
    res.json({ rows });
  } catch (err) {
    console.error('[admin:parsing:top]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * GET /api/admin/parsing/events?cursor=&limit=
 * Pagination par curseur (createdAt desc).
 */
const getEvents = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = {};
    if (req.query.cursor) {
      filter.createdAt = { $lt: new Date(req.query.cursor) };
    }

    const events = await ParsingEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .select('createdAt boutiqueSlug tierResolved haikuInputTokens haikuOutputTokens confidenceScore producedValidProduct')
      .lean();

    const hasMore = events.length > limit;
    const rows = (hasMore ? events.slice(0, limit) : events).map((e) => ({
      id:                 e._id.toString(),
      at:                 e.createdAt,
      slug:               e.boutiqueSlug,
      tierResolved:       e.tierResolved,
      tokens:             (e.haikuInputTokens || 0) + (e.haikuOutputTokens || 0),
      confidence:           (e.confidenceScore || 0) / 100, // EC-01: front fait val*100 pour affichage
      producedValidProduct: e.producedValidProduct,
    }));

    res.json({
      rows,
      nextCursor: hasMore ? events[limit - 1].createdAt.toISOString() : null,
    });
  } catch (err) {
    console.error('[admin:parsing:events]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * GET /api/admin/parsing/events.csv
 * Export CSV (sans bibliothèque tierce).
 */
const getEventsCsv = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);
    const events = await ParsingEvent.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(10_000)
      .lean();

    const header = 'date,slug,tierResolved,tokens,costUsd,confidence,producedValidProduct,latencyMs\n';
    const lines = events.map((e) => [
      e.createdAt.toISOString(),
      e.boutiqueSlug,
      e.tierResolved,
      (e.haikuInputTokens || 0) + (e.haikuOutputTokens || 0),
      (e.costUsd || 0).toFixed(8),
      e.confidenceScore,
      e.producedValidProduct ? 1 : 0,
      e.latencyMs,
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parsing-events.csv"');
    res.send(header + lines);
  } catch (err) {
    console.error('[admin:parsing:csv]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getFunnel, getTop, getEvents, getEventsCsv };
