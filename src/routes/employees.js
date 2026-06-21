const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const Merchant = require('../models/Merchant');
const { authMiddleware } = require('../middleware/auth');
const { requireOwner, validatePermissions } = require('../middleware/permissions');
const { normalizePhone } = require('../utils/phone');
const { GRANTABLE_PERMISSIONS } = require('../constants/permissions');
const { getPlanLimits }         = require('../services/subscriptionService');

const BCRYPT_ROUNDS = 10;

router.use(authMiddleware);

/**
 * GET /api/employees/permissions-catalog
 * Catalogue des permissions octroyables (visible avant requireOwner pour le formulaire).
 */
router.get('/permissions-catalog', (req, res) => {
  res.json({ permissions: GRANTABLE_PERMISSIONS });
});

router.use(requireOwner); // Toutes les routes suivantes sont réservées au patron

/**
 * POST /api/employees
 * Body: { name, phone, password, permissions: [...] }
 */
router.post('/', async (req, res) => {
  try {
    const { name, phone, password, permissions = [] } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'name, phone et password sont requis' });
    }

    // ── Vérification de la limite d'employés du plan ──────────────────────────
    const planLimits = await getPlanLimits(req.merchantId);
    const maxEmp     = planLimits.max_employees;

    if (maxEmp === 0) {
      return res.status(403).json({
        error:   "Votre plan actuel ne permet pas d'ajouter des employés. Passez à un plan supérieur.",
        code:    'EMPLOYEE_LIMIT_REACHED',
        limit:   0,
        current: 0,
      });
    }

    if (maxEmp !== -1) {
      const merchantNow = await Merchant.findById(req.merchantId).select('employees').lean();
      const activeCount = (merchantNow?.employees ?? []).filter(e => e.active !== false).length;
      if (activeCount >= maxEmp) {
        return res.status(403).json({
          error:   `Limite de votre plan atteinte (${activeCount}/${maxEmp} employé${maxEmp > 1 ? 's' : ''}). Passez à un plan supérieur.`,
          code:    'EMPLOYEE_LIMIT_REACHED',
          limit:   maxEmp,
          current: activeCount,
        });
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const permError = validatePermissions(permissions);
    if (permError) return res.status(400).json({ error: permError });

    const normalized = normalizePhone(phone);

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
      { $push: { employees: { name, phone: normalized, passwordHash, permissions } } },
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
        permissions: added.permissions,
        createdAt: added.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/employees
 * Liste sans passwordHash, avec permissions.
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
 * Body: { name?, active?, permissions?, password? }
 * Permet de modifier le nom, le statut actif, les permissions ou de reset le mot de passe.
 */
router.patch('/:id', async (req, res) => {
  try {
    const { name, active, permissions, password } = req.body;

    if (active !== undefined && typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active doit être un boolean' });
    }

    if (permissions !== undefined) {
      const permError = validatePermissions(permissions);
      if (permError) return res.status(400).json({ error: permError });
    }

    const merchant = await Merchant.findOne({
      _id: req.merchantId,
      'employees._id': req.params.id,
    });
    if (!merchant) return res.status(404).json({ error: 'Employé introuvable' });

    const employee = merchant.employees.id(req.params.id);

    // Gating : réactivation d'un employé précédemment désactivé
    if (active === true && employee.active === false) {
      const planLimits = await getPlanLimits(req.merchantId);
      const maxEmp     = planLimits.max_employees;

      if (maxEmp === 0) {
        return res.status(403).json({
          error:   "Votre plan actuel ne permet pas d'ajouter des employés. Passez à un plan supérieur.",
          code:    'EMPLOYEE_LIMIT_REACHED',
          limit:   0,
          current: 0,
        });
      }

      if (maxEmp !== -1) {
        // Compter les actifs en excluant cet employé (actuellement inactif)
        const activeCount = merchant.employees.filter(
          (e) => e._id.toString() !== req.params.id && e.active !== false
        ).length;
        if (activeCount >= maxEmp) {
          return res.status(403).json({
            error:   `Limite de votre plan atteinte (${activeCount}/${maxEmp} employé${maxEmp > 1 ? 's' : ''}). Passez à un plan supérieur.`,
            code:    'EMPLOYEE_LIMIT_REACHED',
            limit:   maxEmp,
            current: activeCount,
          });
        }
      }
    }

    if (name !== undefined) employee.name = name;
    if (active !== undefined) employee.active = active;
    if (permissions !== undefined) employee.permissions = permissions;
    if (password !== undefined) {
      employee.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    await merchant.save();

    res.json({
      success: true,
      employee: {
        id: employee._id,
        name: employee.name,
        phone: employee.phone,
        active: employee.active,
        permissions: employee.permissions,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/employees/:id
 * Soft-delete : active = false. Pas de hard-delete pour préserver l'historique performedBy.
 */
router.delete('/:id', async (req, res) => {
  try {
    const merchant = await Merchant.findOneAndUpdate(
      { _id: req.merchantId, 'employees._id': req.params.id },
      { $set: { 'employees.$.active': false } },
      { new: true }
    );

    if (!merchant) return res.status(404).json({ error: 'Employé introuvable' });

    res.json({ success: true, message: 'Employé désactivé (soft-delete — historique préservé)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
