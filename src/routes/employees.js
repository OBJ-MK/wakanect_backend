const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const Merchant = require('../models/Merchant');
const { authMiddleware } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');

const BCRYPT_ROUNDS = 10;

router.use(authMiddleware);

/**
 * POST /api/employees
 * Ajouter un employé (patron uniquement)
 * Body: { name, phone, password }
 */
router.post('/', async (req, res) => {
  try {
    const { name, phone, password } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'name, phone et password sont requis' });
    }

    const normalized = normalizePhone(phone);

    // Unicité globale : un numéro ne peut appartenir qu'à une seule boutique (patron OU employé)
    const conflict = await Merchant.findOne({
      $or: [
        { whatsappPhone: normalized },
        { employees: { $elemMatch: { phone: normalized } } },
      ],
    });
    if (conflict) {
      return res.status(409).json({ error: 'Ce numéro est déjà associé à une boutique' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const merchant = await Merchant.findByIdAndUpdate(
      req.merchantId,
      { $push: { employees: { name, phone: normalized, passwordHash } } },
      { new: true, runValidators: true }
    );

    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    const added = merchant.employees[merchant.employees.length - 1];

    res.status(201).json({
      success: true,
      employee: {
        id: added._id,
        name: added.name,
        phone: added.phone,
        active: added.active,
        createdAt: added.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/employees
 * Lister les employés sans passwordHash
 */
router.get('/', async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.merchantId, {
      'employees.passwordHash': 0,
    }).lean();

    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    res.json({ employees: merchant.employees || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/employees/:id
 * Activer / désactiver un employé
 * Body: { active: boolean }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { active } = req.body;

    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) est requis' });
    }

    const merchant = await Merchant.findOneAndUpdate(
      { _id: req.merchantId, 'employees._id': req.params.id },
      { $set: { 'employees.$.active': active } },
      { new: true }
    );

    if (!merchant) return res.status(404).json({ error: 'Employé introuvable' });

    const employee = merchant.employees.id(req.params.id);

    res.json({
      success: true,
      employee: {
        id: employee._id,
        name: employee.name,
        phone: employee.phone,
        active: employee.active,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
