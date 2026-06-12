const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const Merchant = require('../models/Merchant');
const { authMiddleware } = require('../middleware/auth');
const { signMerchantToken } = require('../utils/jwt');

const BCRYPT_ROUNDS = 10;

/**
 * POST /api/merchants/register
 */
router.post('/register', async (req, res) => {
  try {
    const { businessName, slug, ownerName, email, whatsappPhone, whatsappPhoneId, catalogDescription, password } = req.body;

    if (!businessName || !slug || !whatsappPhone || !password) {
      return res.status(400).json({ error: 'Champs requis : businessName, slug, whatsappPhone, password' });
    }

    const existing = await Merchant.findOne({ $or: [{ slug }, { whatsappPhone }] });
    if (existing) {
      const field = existing.slug === slug ? 'slug' : 'numéro WhatsApp';
      return res.status(409).json({ error: `Ce ${field} est déjà utilisé` });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const merchant = await Merchant.create({
      businessName,
      slug,
      ownerName,
      email,
      whatsappPhone,
      whatsappPhoneId,
      catalogDescription,
      passwordHash,
    });

    res.status(201).json({
      success: true,
      merchant: {
        id: merchant._id,
        businessName: merchant.businessName,
        slug: merchant.slug,
        storeUrl: `${process.env.APP_URL}/boutique/${merchant.slug}`,
      },
      token: signMerchantToken(merchant),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Slug ou numéro WhatsApp déjà pris' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/merchants/login
 * Accepte whatsappPhone ou email pour compatibilité — le nouvel endpoint canonique est /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, whatsappPhone, password } = req.body;

    if (!password || (!email && !whatsappPhone)) {
      return res.status(400).json({ error: 'Fournir (email ou whatsappPhone) et password' });
    }

    const query = email ? { email: email.toLowerCase().trim() } : { whatsappPhone };
    const merchant = await Merchant.findOne(query);

    if (!merchant || !merchant.isActive || !merchant.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    res.json({
      success: true,
      merchant: {
        id: merchant._id,
        businessName: merchant.businessName,
        slug: merchant.slug,
        storeUrl: `${process.env.APP_URL}/boutique/${merchant.slug}`,
      },
      token: signMerchantToken(merchant),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/merchants/me
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.merchantId, {
      passwordHash: 0,
      'employees.passwordHash': 0,
    }).lean();

    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    res.json({
      ...merchant,
      storeUrl: `${process.env.APP_URL}/boutique/${merchant.slug}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
