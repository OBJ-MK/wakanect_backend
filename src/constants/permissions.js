/**
 * Permissions octroyables par le patron à ses employés.
 * Toute clé absente de cette liste est rejetée à l'assignation.
 *
 * NON OCTROYABLES (owner only, hors catalogue) :
 *   - gestion des employés, facturation/abonnement, paramètres compte/boutique
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
