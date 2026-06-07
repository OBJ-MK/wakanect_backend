const express = require('express');
const router = express.Router();
const Merchant = require('../models/Merchant');

/**
 * POST /api/merchants/register
 * Inscription d'un nouveau commerçant (MVP : pas de vérification email)
 */
router.post('/register', async (req, res) => {
  try {
    const { businessName, slug, ownerName, email, whatsappPhone, whatsappPhoneId, catalogDescription } = req.body;

    if (!businessName || !slug || !whatsappPhone) {
      return res.status(400).json({ error: 'Champs requis : businessName, slug, whatsappPhone' });
    }

    const existing = await Merchant.findOne({ $or: [{ slug }, { whatsappPhone }] });
    if (existing) {
      const field = existing.slug === slug ? 'slug' : 'numéro WhatsApp';
      return res.status(409).json({ error: `Ce ${field} est déjà utilisé` });
    }

    const merchant = await Merchant.create({
      businessName,
      slug,
      ownerName,
      email,
      whatsappPhone,
      whatsappPhoneId,
      catalogDescription,
    });

    // Pour le MVP, le token = merchantId (voir middleware/auth.js)
    res.status(201).json({
      success: true,
      merchant: {
        id: merchant._id,
        businessName: merchant.businessName,
        slug: merchant.slug,
        storeUrl: `${process.env.APP_URL}/boutique/${merchant.slug}`,
      },
      //   MVP uniquement — à remplacer par JWT
      token: merchant._id,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Slug ou numéro WhatsApp déjà pris' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/merchants/me
 * Profil du commerçant connecté
 */
router.get('/me', require('../middleware/auth').authMiddleware, async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.merchantId).lean();
    res.json({
      ...merchant,
      storeUrl: `${process.env.APP_URL}/boutique/${merchant.slug}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
