/**
 * Permissions octroyables par le patron à ses employés.
 * Toute clé absente de cette liste est rejetée à l'assignation.
 *
 * Les 3 zones sensibles (boutique, équipe, abonnement) sont interdites à tout
 * employé SAUF permission explicite dédiée (shop.manage / team.manage /
 * billing.manage). Le propriétaire a tout, toujours, implicitement.
 */
const GRANTABLE_PERMISSIONS = [
  'dashboard.view',   // voir le dashboard (lectures)
  'products.send',    // envoyer des produits via WhatsApp
  'products.publish', // valider / publier un produit depuis la file
  'products.edit',    // éditer / supprimer un produit + gérer ses images
  'stock.edit',       // éditer le stock manuellement
  'orders.confirm',   // confirmer une commande
  'orders.cancel',    // annuler une commande
  'orders.markPaid',  // marquer une commande payée
  'shop.manage',      // modifier les informations de la boutique (+ logo)
  'team.manage',      // gérer les employés (Mon équipe)
  'billing.manage',   // gérer l'abonnement / la facturation
];

/**
 * Permissions attribuées aux employés créés avant l'introduction du système
 * de permissions, pour préserver leur comportement antérieur.
 */
const DEFAULT_LEGACY_PERMISSIONS = [
  'dashboard.view',
  'products.send',
  'orders.confirm',
];

module.exports = { GRANTABLE_PERMISSIONS, DEFAULT_LEGACY_PERMISSIONS };
