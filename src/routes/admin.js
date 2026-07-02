'use strict';

const express = require('express');
const router  = express.Router();

const { requireSuperadmin } = require('../middleware/adminAuth');

const { getOverview }    = require('../controllers/admin/overviewController');
const { getFunnel, getTop, getEvents, getEventsCsv } = require('../controllers/admin/parsingController');
const { listBoutiques, getBoutique, suspendBoutique, reactivateBoutique, extendTrial, changePlan, resetPassword, impersonate } =
  require('../controllers/admin/boutiquesController');
const { getAbonnements } = require('../controllers/admin/abonnementsController');
const { getPlans, updatePlan } = require('../controllers/admin/plansController');
const { listEmployes }   = require('../controllers/admin/employesController');
const { getSante }       = require('../controllers/admin/santeController');
const { getAudit }       = require('../controllers/admin/auditController');

// Toutes les routes /api/admin/* sont protégées par requireSuperadmin
router.use(requireSuperadmin);

// ── Overview ──────────────────────────────────────────────────────────────────
router.get('/overview', getOverview);

// ── Parsing ───────────────────────────────────────────────────────────────────
router.get('/parsing/funnel',     getFunnel);
router.get('/parsing/top',        getTop);
router.get('/parsing/events.csv', getEventsCsv);
router.get('/parsing/events',     getEvents);

// ── Boutiques ─────────────────────────────────────────────────────────────────
router.get('/boutiques',                    listBoutiques);
router.get('/boutiques/:slug',              getBoutique);
router.post('/boutiques/:id/suspend',       suspendBoutique);
router.post('/boutiques/:id/reactivate',    reactivateBoutique);
router.post('/boutiques/:id/extend-trial',  extendTrial);
router.post('/boutiques/:id/change-plan',   changePlan);
router.post('/boutiques/:id/reset-password', resetPassword);
router.post('/boutiques/:id/impersonate',   impersonate);

// ── Employés ──────────────────────────────────────────────────────────────────
router.get('/employes', listEmployes);

// ── Abonnements ───────────────────────────────────────────────────────────────
router.get('/abonnements', getAbonnements);

// ── Plans (config tarifaire éditable) ────────────────────────────────────────
router.get('/plans',         getPlans);
router.patch('/plans/:plan', updatePlan);

// ── Santé opérationnelle ──────────────────────────────────────────────────────
router.get('/sante', getSante);

// ── Audit ─────────────────────────────────────────────────────────────────────
router.get('/audit', getAudit);

module.exports = router;
