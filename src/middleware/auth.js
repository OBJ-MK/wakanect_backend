const Merchant = require('../models/Merchant');

/**
 * Middleware d'authentification — MVP simple
 * 
 * Pour le MVP on utilise un token statique par commerçant.
 * Header attendu : Authorization: Bearer <merchantId>
 * 
 *   À remplacer par JWT ou session avant mise en production réelle.
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const token = authHeader.split(' ')[1];

    // Pour le MVP : le token = merchantId
    // TODO: remplacer par JWT signé
    const merchant = await Merchant.findById(token).lean();

    if (!merchant || !merchant.isActive) {
      return res.status(401).json({ error: 'Commerçant non trouvé ou inactif' });
    }

    // Injecter dans la requête
    req.merchantId = merchant._id;
    req.merchant = merchant;

    next();
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(401).json({ error: 'Token invalide' });
    }
    console.error(' Auth middleware:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { authMiddleware };
