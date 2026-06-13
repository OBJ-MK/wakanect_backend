const jwt = require('jsonwebtoken');
const Merchant = require('../models/Merchant');

/**
 * Vérifie le JWT et injecte req.merchantId + req.actor.
 *
 * Pour les tokens employé : revérifie EN BASE que l'employé existe et est actif,
 * et attache req.employeePermissions (lecture live → changements instantanés).
 */
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.merchantId = payload.sub;
    req.actor = {
      type: payload.actorType,
      id: payload.actorId,
      name: payload.actorName,
      phone: payload.actorPhone,
    };

    if (payload.actorType === 'employee') {
      // Revérification live : actif + permissions à jour (pas depuis le JWT)
      const merchant = await Merchant.findOne(
        { _id: payload.sub, 'employees._id': payload.actorId },
        { 'employees.$': 1 }
      );

      if (!merchant || !merchant.employees.length) {
        return res.status(401).json({ error: 'Compte employé introuvable' });
      }

      const employee = merchant.employees[0];
      if (!employee.active) {
        return res.status(401).json({ error: 'Compte employé désactivé' });
      }

      req.employeePermissions = employee.permissions || [];
    }

    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expiré' : 'Token invalide';
    return res.status(401).json({ error: message });
  }
};

module.exports = { authMiddleware };
