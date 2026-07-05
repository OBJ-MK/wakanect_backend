'use strict';

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const Merchant     = require('../models/Merchant');
const Subscription = require('../models/Subscription');
const PlanConfig   = require('../models/PlanConfig');
const { authMiddleware }    = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleUpload }      = require('../middleware/upload');
const { compressImage, uploadToR2 } = require('../services/mediaService');
const { signMerchantToken } = require('../utils/jwt');
const { normalizePhone }          = require('../utils/phone');
const { toMerchantDTO }           = require('../utils/dto');
const { getPlanLimits }           = require('../services/subscriptionService');
const { detectCountryFromPhone }  = require('../constants/pricingGrid');

const BCRYPT_ROUNDS = 10;

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
 * POST /api/merchants/register
 */
router.post('/register', async (req, res) => {
  try {
    const { businessName, slug, ownerName, email, whatsappPhone, whatsappPhoneId, catalogDescription, password } = req.body;

    if (!businessName || !slug || !whatsappPhone || !password) {
      return res.status(400).json({ error: 'Champs requis : businessName, slug, whatsappPhone, password' });
    }

    const normalized = normalizePhone(whatsappPhone);

    const existing = await Merchant.findOne({
      $or: [
        { slug },
        { whatsappPhone: normalized },
        { employees: { $elemMatch: { phone: normalized } } },
      ],
    });
    if (existing) {
      const field = existing.slug === slug ? 'slug' : 'numéro WhatsApp';
      return res.status(409).json({ error: `Ce ${field} est déjà utilisé` });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Code OTP inversé : le commerçant l'ENVOIE au numéro Wakanect via wa.me.
    // Valable 7 jours ; dormant tant que WAKANECT_WHATSAPP_NUMBER est vide.
    const verificationCode = String(Math.floor(100000 + Math.random() * 900000));

    const merchant = await Merchant.create({
      businessName,
      slug,
      ownerName,
      email,
      whatsappPhone: normalized,
      whatsappPhoneId,
      catalogDescription,
      passwordHash,
      country: detectCountryFromPhone(normalized),
      phoneVerification: {
        verified:  false,
        code:      verificationCode,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Pas de souscription encore au moment de l'inscription
    const scansQuota = await resolveScansQuota(merchant.plan);

    res.status(201).json({
      success:  true,
      token:    signMerchantToken(merchant),
      merchant: await toMerchantDTO(merchant, null, scansQuota),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Slug ou numéro WhatsApp déjà pris' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/merchants/login  (endpoint legacy — préférer /api/auth/login)
 */
router.post('/login', async (req, res) => {
  try {
    const { email, whatsappPhone, password } = req.body;

    if (!password || (!email && !whatsappPhone)) {
      return res.status(400).json({ error: 'Fournir (email ou whatsappPhone) et password' });
    }

    const query = email
      ? { email: email.toLowerCase().trim() }
      : { whatsappPhone: normalizePhone(whatsappPhone) };

    const merchant = await Merchant.findOne(query);

    if (!merchant || !merchant.isActive || !merchant.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const [subscription, scansQuota] = await Promise.all([
      Subscription.findOne({ merchantId: merchant._id }).sort({ createdAt: -1 }).lean(),
      resolveScansQuota(merchant.plan),
    ]);

    res.json({
      success:  true,
      token:    signMerchantToken(merchant),
      merchant: await toMerchantDTO(merchant, subscription, scansQuota),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/merchants/me/logo
 * Upload du logo boutique : compresse via sharp → stocke sur R2 → persiste logoUrl en base.
 * Owner, ou employé avec la permission shop.manage. Multer : 5 Mo max, MIME jpeg/png/webp.
 */
router.post(
  '/me/logo',
  authMiddleware,
  requirePermission('shop.manage'),
  handleUpload('logo'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });
    try {
      const { buffer } = await compressImage(req.file.buffer);
      const { url } = await uploadToR2(buffer, {
        merchantId: req.merchantId,
        folder: `merchants/${req.merchantId}/logo`,
      });

      await Merchant.findByIdAndUpdate(req.merchantId, { $set: { logoUrl: url } });

      res.json({ logoUrl: url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PATCH /api/merchants/me
 * Champs éditables : businessName, ownerName, slug, address, catalogDescription, logoUrl, bannerUrl
 * Owner, ou employé avec la permission shop.manage.
 */
router.patch('/me', authMiddleware, requirePermission('shop.manage'), async (req, res) => {
  try {
    const EDITABLE = ['businessName', 'ownerName', 'slug', 'address', 'catalogDescription', 'logoUrl', 'bannerUrl'];
    const updates = {};
    for (const key of EDITABLE) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
    }

    if (updates.slug) {
      updates.slug = updates.slug.toLowerCase().trim();
      const conflict = await Merchant.findOne({ slug: updates.slug, _id: { $ne: req.merchantId } });
      if (conflict) return res.status(409).json({ error: 'Ce slug est déjà utilisé' });
    }

    const merchant = await Merchant.findByIdAndUpdate(
      req.merchantId,
      { $set: updates },
      { new: true, runValidators: true, projection: { passwordHash: 0, 'employees.passwordHash': 0 } }
    );

    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    const [subscription, planConfig] = await Promise.all([
      Subscription.findOne({ merchantId: req.merchantId }).sort({ createdAt: -1 }).lean(),
      PlanConfig.findOne({ key: 'main' }),
    ]);

    let scansQuota = 100;
    if (planConfig) {
      if (merchant.plan === 'pro')           scansQuota = planConfig.getEffectiveScans('pro');
      else if (merchant.plan === 'premium')  scansQuota = planConfig.getEffectiveScans('premium');
      else                                   scansQuota = planConfig.trial?.scans || 100;
    }

    res.json(await toMerchantDTO(merchant, subscription, scansQuota));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Ce slug est déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/merchants/me
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const [merchant, subscription, planConfig, planLimits] = await Promise.all([
      Merchant.findById(req.merchantId, { passwordHash: 0, 'employees.passwordHash': 0 }),
      Subscription.findOne({ merchantId: req.merchantId }).sort({ createdAt: -1 }).lean(),
      PlanConfig.findOne({ key: 'main' }),
      getPlanLimits(req.merchantId),
    ]);

    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    let scansQuota = 100;
    if (planConfig) {
      if (merchant.plan === 'pro')           scansQuota = planConfig.getEffectiveScans('pro');
      else if (merchant.plan === 'premium')  scansQuota = planConfig.getEffectiveScans('premium');
      else                                   scansQuota = planConfig.trial?.scans || 100;
    }

    // Pour un token employé, surcharger role + permissions depuis req.actor
    let actorOverride;
    if (req.actor?.type === 'employee') {
      actorOverride = {
        role:        'employee',
        permissions: req.employeePermissions || [],
        name:        req.actor.name,
        phone:       req.actor.phone,
      };
    }

    res.json(await toMerchantDTO(merchant, subscription, scansQuota, actorOverride, planLimits));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
