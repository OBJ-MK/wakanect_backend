'use strict';

const AdminSettings = require('../../models/AdminSettings');

/**
 * GET /api/admin/settings/pilot
 * Retourne les dates du pilote configurées (ou null si jamais renseignées —
 * voir adminStatsService.js#parseDateRange pour le comportement de repli).
 */
const getPilotConfig = async (req, res) => {
  try {
    const settings = await AdminSettings.findOne({ key: 'pilot' }).lean();
    res.json({
      pilot_start_date: settings?.pilotStartDate || null,
      pilot_end_date: settings?.pilotEndDate || null,
    });
  } catch (err) {
    console.error('[admin:settings:get]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * PATCH /api/admin/settings/pilot
 * body: { pilot_start_date?, pilot_end_date? } — ISO strings, ou null pour effacer.
 * Upsert : la doc 'pilot' est créée au premier enregistrement.
 */
const updatePilotConfig = async (req, res) => {
  try {
    const { pilot_start_date, pilot_end_date } = req.body;
    const update = {};
    if (pilot_start_date !== undefined) {
      update.pilotStartDate = pilot_start_date ? new Date(pilot_start_date) : null;
    }
    if (pilot_end_date !== undefined) {
      update.pilotEndDate = pilot_end_date ? new Date(pilot_end_date) : null;
    }

    const settings = await AdminSettings.findOneAndUpdate(
      { key: 'pilot' },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({
      pilot_start_date: settings.pilotStartDate || null,
      pilot_end_date: settings.pilotEndDate || null,
    });
  } catch (err) {
    console.error('[admin:settings:patch]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getPilotConfig, updatePilotConfig };
