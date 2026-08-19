'use strict';

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Retourne un message d'erreur si le mot de passe est trop court, sinon null.
 * VUL-009 : longueur minimale imposée côté serveur (pas seulement côté UI).
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`;
  }
  return null;
}

/**
 * Retourne un message d'erreur si l'email est absent d'un format valide, sinon null.
 * L'email est optionnel sur Merchant — n'appeler ce validateur que s'il est fourni.
 */
function validateEmail(email) {
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    return 'Format d\'email invalide';
  }
  return null;
}

module.exports = { validatePassword, validateEmail, MIN_PASSWORD_LENGTH };