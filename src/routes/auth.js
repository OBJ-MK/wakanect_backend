const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const Merchant = require('../models/Merchant');
const { signMerchantToken, signEmployeeToken } = require('../utils/jwt');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
});

/**
 * POST /api/auth/login
 * Connexion patron : { whatsappNumber, password }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { whatsappNumber, password } = req.body;

    if (!whatsappNumber || !password) {
      return res.status(400).json({ error: 'whatsappNumber et password sont requis' });
    }

    const merchant = await Merchant.findOne({ whatsappPhone: whatsappNumber });

    if (!merchant || !merchant.isActive || !merchant.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const merchantObj = merchant.toObject();
    delete merchantObj.passwordHash;
    delete merchantObj.employees;

    res.json({
      success: true,
      token: signMerchantToken(merchant),
      merchant: merchantObj,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/auth/employee/login
 * Connexion employé : { boutiqueSlug, phone, password }
 */
router.post('/employee/login', loginLimiter, async (req, res) => {
  try {
    const { boutiqueSlug, phone, password } = req.body;

    if (!boutiqueSlug || !phone || !password) {
      return res.status(400).json({ error: 'boutiqueSlug, phone et password sont requis' });
    }

    const merchant = await Merchant.findOne({ slug: boutiqueSlug, isActive: true });

    // Message générique — ne pas révéler si c'est le slug ou l'employé qui est invalide
    if (!merchant) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const employee = merchant.employees.find((e) => e.phone === phone && e.active);

    if (!employee || !employee.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const valid = await bcrypt.compare(password, employee.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    res.json({
      success: true,
      token: signEmployeeToken(merchant, employee),
      employee: {
        id: employee._id,
        name: employee.name,
        phone: employee.phone,
      },
      merchant: {
        id: merchant._id,
        businessName: merchant.businessName,
        slug: merchant.slug,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
