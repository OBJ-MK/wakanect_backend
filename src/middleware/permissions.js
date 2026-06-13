const { GRANTABLE_PERMISSIONS } = require('../constants/permissions');

/**
 * Réserve la route au propriétaire de la boutique.
 * Les employés reçoivent un 403, quelle que soit leur liste de permissions.
 */
const requireOwner = (req, res, next) => {
  if (req.actor?.type === 'owner') return next();
  return res.status(403).json({ error: 'Réservé au propriétaire de la boutique' });
};

/**
 * Vérifie qu'un acteur possède la permission demandée.
 *
 * - owner    → passe toujours.
 * - employee → vérifie req.employeePermissions (chargées live depuis la DB
 *              par authMiddleware, donc toujours à jour sans re-login).
 *
 * @param {string | ((req) => string | null)} keyOrFn
 *   Clé de permission, ou fonction (req) => clé (utile quand la permission
 *   dépend du body, ex. orders.confirm vs orders.cancel sur le même endpoint).
 *   Si la fonction retourne null, la vérification est ignorée.
 */
const requirePermission = (keyOrFn) => (req, res, next) => {
  if (req.actor?.type === 'owner') return next();

  const key = typeof keyOrFn === 'function' ? keyOrFn(req) : keyOrFn;
  if (!key) return next();

  const permissions = req.employeePermissions || [];
  if (!permissions.includes(key)) {
    return res.status(403).json({ error: `Permission requise : ${key}` });
  }
  next();
};

/**
 * Valide un tableau de clés de permissions à l'assignation.
 * Retourne un message d'erreur si invalide, null sinon.
 */
const validatePermissions = (permissions) => {
  if (!Array.isArray(permissions)) return 'permissions doit être un tableau';
  const invalid = permissions.filter((p) => !GRANTABLE_PERMISSIONS.includes(p));
  if (invalid.length > 0) {
    return `Permission(s) inconnue(s) ou non octroyable(s) : ${invalid.join(', ')}`;
  }
  return null;
};

module.exports = { requireOwner, requirePermission, validatePermissions };
