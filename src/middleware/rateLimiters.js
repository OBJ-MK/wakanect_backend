'use strict';

const rateLimit = require('express-rate-limit');

// Login (marchand, employé, admin) : 10 tentatives / 15 min par IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
});

// Inscription : plus permissif (usage légitime rare mais pas exceptionnel),
// évite surtout le spam automatisé / l'énumération de slugs.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives d\'inscription, réessayez plus tard' },
});

module.exports = { loginLimiter, registerLimiter };