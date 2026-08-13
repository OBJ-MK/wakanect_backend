'use strict';

const jwt = require('jsonwebtoken');
const Merchant = require('../models/Merchant');
const { ADMIN_SENTINEL_ID } = require('../utils/jwt');

const requireSuperadmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.actorType !== 'superadmin') {
      return res.status(403).json({ error: 'Accès réservé au superadmin' });
    }

    // Admin basé sur env : pas de document Merchant à revérifier.
    // Révocation immédiate = retirer/changer ADMIN_PASSWORD_HASH sur Render.
    if (payload.sub === ADMIN_SENTINEL_ID) {
      if (!process.env.ADMIN_PASSWORD_HASH) {
        return res.status(403).json({ error: 'Compte superadmin désactivé' });
      }
      req.adminId = payload.sub;
      req.adminName = payload.actorName;
      req.adminPhone = payload.actorPhone;
      return next();
    }

    // Repli rétrocompat : anciens tokens superadmin liés à un vrai Merchant
    const admin = await Merchant.findById(payload.sub).select('role isActive').lean();
    if (!admin || admin.role !== 'superadmin' || !admin.isActive) {
      return res.status(403).json({ error: 'Compte superadmin invalide ou désactivé' });
    }

    req.adminId = payload.sub;
    req.adminName = payload.actorName;
    req.adminPhone = payload.actorPhone;
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expiré' : 'Token invalide';
    return res.status(401).json({ error: message });
  }
};

module.exports = { requireSuperadmin };