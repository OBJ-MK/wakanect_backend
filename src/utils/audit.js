'use strict';

const AuditLog = require('../models/AuditLog');

/**
 * Écrit une entrée dans le journal d'audit cross-tenant (visible en admin → Journal d'audit).
 *
 * Un échec d'écriture d'audit ne doit JAMAIS faire échouer l'action métier qui l'a déclenché :
 * toute erreur est loguée en console et avalée silencieusement.
 *
 * @param {object}  params
 * @param {'admin'|'owner'|'employee'} params.authorType
 * @param {string}  [params.authorId]
 * @param {string}  [params.authorName]
 * @param {string}  [params.authorPhone]
 * @param {string}  params.action        - ex: 'order.status_changed', 'order.payment_marked',
 *                                          'product.created', 'login.failed', 'parsing.validated'
 * @param {boolean} [params.success=true]
 * @param {string}  [params.target]      - ID du document affecté
 * @param {string|import('mongoose').Types.ObjectId} [params.merchantId]
 * @param {string}  [params.slug]
 * @param {object}  [params.metadata]    - contexte libre : before/after, raison de l'échec, etc.
 */
async function logAudit({
  authorType,
  authorId = null,
  authorName = null,
  authorPhone = null,
  action,
  success = true,
  target = null,
  merchantId = null,
  slug = null,
  metadata = {},
}) {
  try {
    await AuditLog.create({
      authorType,
      authorId,
      authorName,
      authorPhone,
      action,
      success,
      target,
      merchantId,
      slug,
      metadata,
    });
  } catch (err) {
    console.error('[audit] échec écriture:', err.message);
  }
}

/**
 * Construit les champs authorType/authorId/authorName/authorPhone depuis req.actor
 * (injecté par authMiddleware) — pour usage direct avec logAudit.
 */
function auditActorFromReq(req) {
  return {
    authorType:  req.actor?.type  || 'owner',
    authorId:    req.actor?.id    || null,
    authorName:  req.actor?.name  || null,
    authorPhone: req.actor?.phone || null,
  };
}

module.exports = { logAudit, auditActorFromReq };