'use strict';

const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcrypt');
const rateLimit  = require('express-rate-limit');
const Merchant   = require('../models/Merchant');
const Subscription = require('../models/Subscription');
const PlanConfig   = require('../models/PlanConfig');
const { signMerchantToken, signEmployeeToken, signSuperadminToken } = require('../utils/jwt');
const { normalizePhone } = require('../utils/phone');
const { toMerchantDTO } = require('../utils/dto');
const { getPlanLimits } = require('../services/subscriptionService');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
});

// ─── Helper : quota depuis PlanConfig ────────────────────────────────────────

async function resolveScansQuota(plan) {
  try {
    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) return 100;
    if (plan === 'pro')     return pc.getEffectiveScans('pro');
    if (plan === 'premium') return pc.getEffectiveScans('premium');
    return pc.trial?.scans || 100;
  } catch {
    return 100;
  }
}

/**
 * POST /api/auth/login
 * Patron : { identifier, password }   (identifier = numéro WA ou email)
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    // Accepte aussi l'ancien champ whatsappNumber pour rétrocompat interne
    const identifier = req.body.identifier || req.body.whatsappNumber;
    const { password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier et password sont requis' });
    }

    // Détection phone vs email : un phone commence par un chiffre ou +
    let merchant;
    if (/^[+\d]/.test(identifier)) {
      merchant = await Merchant.findOne({ whatsappPhone: normalizePhone(identifier) });
    } else {
      merchant = await Merchant.findOne({ email: identifier.toLowerCase().trim() });
    }

    if (!merchant || !merchant.isActive || !merchant.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const [subscription, scansQuota, planLimits] = await Promise.all([
      Subscription.findOne({ merchantId: merchant._id }).sort({ createdAt: -1 }).lean(),
      resolveScansQuota(merchant.plan),
      getPlanLimits(merchant._id),
    ]);

    const token = merchant.role === 'superadmin'
      ? signSuperadminToken(merchant)
      : signMerchantToken(merchant);

    res.json({
      success: true,
      token,
      merchant: toMerchantDTO(merchant, subscription, scansQuota, undefined, planLimits),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/auth/employee/login
 * Employé : { boutiqueSlug, phone, password }
 * Renvoie { token, merchant: MerchantDTO } avec role:"employee" + permissions.
 */
router.post('/employee/login', loginLimiter, async (req, res) => {
  try {
    const { boutiqueSlug, phone, password } = req.body;

    if (!boutiqueSlug || !phone || !password) {
      return res.status(400).json({ error: 'boutiqueSlug, phone et password sont requis' });
    }

    const normalized = normalizePhone(phone);
    const merchant   = await Merchant.findOne({ slug: boutiqueSlug, isActive: true });

    if (!merchant) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const employee = merchant.employees.find((e) => e.phone === normalized && e.active);

    if (!employee || !employee.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, employee.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const [subscription, scansQuota] = await Promise.all([
      Subscription.findOne({ merchantId: merchant._id }).sort({ createdAt: -1 }).lean(),
      resolveScansQuota(merchant.plan),
    ]);

    res.json({
      success: true,
      token:   signEmployeeToken(merchant, employee),
      merchant: toMerchantDTO(merchant, subscription, scansQuota, {
        role:        'employee',
        permissions: employee.permissions || [],
      }),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/auth/admin/login
 * Superadmin : { phone, password }
 */
router.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'phone et password sont requis' });
    }

    const normalized = normalizePhone(phone);
    const admin      = await Merchant.findOne({ whatsappPhone: normalized, role: 'superadmin' });

    if (!admin || !admin.isActive || !admin.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    res.json({
      success:  true,
      token:    signSuperadminToken(admin),
      merchant: toMerchantDTO(admin, null, 100),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
