'use strict';

/**
 * Routes de callback internes — NE jamais exposer ces endpoints dans la doc commerçant.
 * La sécurité de l'IPN repose sur la vérification du hash SHA-512,
 * pas sur un token d'authentification.
 */

const express      = require('express');
const router       = express.Router();
const Merchant     = require('../models/Merchant');
const Subscription = require('../models/Subscription');
const Payment      = require('../models/Payment');
const { verifyIpnHash, confirmInvoice } = require('../services/paydunyaService');

// Durée nominale en mois par période (multiplicateurs de prix != durée)
const PERIOD_MONTHS = {
  monthly:    1,
  quarterly:  3,
  semiannual: 6,
  annual:     12,
};

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Empile la date de fin sur l'abonnement existant (ou crée si absent).
 * Décision C — empilage uniforme : finActuelle = endDate courant (essai inclus).
 * newEndDate = max(maintenant, finActuelle) + duréePériode
 */
async function activateSubscription(payment) {
  const { merchantId, plan, period, amount, paydunyaInvoiceToken, country } = payment;
  const months = PERIOD_MONTHS[period];
  const now    = new Date();

  const currentSub = await Subscription.findOne({ merchantId }).sort({ createdAt: -1 });

  const baseDate = currentSub
    ? new Date(Math.max(now.getTime(), new Date(currentSub.endDate).getTime()))
    : now;

  const newEndDate = addMonths(baseDate, months);

  if (currentSub) {
    await Subscription.findByIdAndUpdate(currentSub._id, {
      plan,
      period,
      status:      'active',
      endDate:     newEndDate,
      amountFcfa:  amount,
      paydunyaRef: paydunyaInvoiceToken,
    });
  } else {
    await Subscription.create({
      merchantId,
      plan,
      period,
      country,
      startDate:   now,
      endDate:     newEndDate,
      status:      'active',
      amountFcfa:  amount,
      paydunyaRef: paydunyaInvoiceToken,
    });
  }

  // Lockstep : plan miroir sur Merchant (pour les lookups quota/features)
  await Merchant.findByIdAndUpdate(merchantId, { plan });
}

/**
 * POST /api/paydunya/ipn
 * PUBLIC — aucun authMiddleware. Sécurité via hash SHA-512.
 * PayDunya envoie en application/x-www-form-urlencoded, corps : data=<JSON>.
 * On répond TOUJOURS 200 pour stopper les relances PayDunya.
 */
router.post('/ipn', async (req, res) => {
  // Réponse immédiate garantie — l'activation est asynchrone
  const respond = () => res.sendStatus(200);

  try {
    // Parsing du body urlencoded (monté globalement dans index.js)
    let ipnData;
    try {
      ipnData = JSON.parse(req.body?.data || '{}');
    } catch {
      console.warn('[IPN] body.data non parseable');
      return respond();
    }

    // Règle 2 — vérification hash SHA-512
    if (!verifyIpnHash(ipnData.hash)) {
      console.warn('[IPN] hash invalide — rejeté');
      return respond();
    }

    const token = ipnData.invoice?.token || ipnData.token;
    if (!token) {
      console.warn('[IPN] token manquant');
      return respond();
    }

    // Règle 3 — re-confirmation serveur-à-serveur
    let confirmData;
    try {
      confirmData = await confirmInvoice(token);
    } catch (e) {
      console.error('[IPN] confirmInvoice:', e.message);
      return respond();
    }

    const confirmedStatus = confirmData.invoice?.status ?? confirmData.status;
    if (confirmedStatus !== 'completed') {
      return respond();
    }

    const confirmedAmount = Number(
      confirmData.invoice?.total_amount ?? confirmData.total_amount ?? -1
    );

    // Règle 4 — retrouver le Payment par token (idempotence)
    const payment = await Payment.findOne({ paydunyaInvoiceToken: token });
    if (!payment) {
      console.warn('[IPN] Payment introuvable pour token:', token);
      return respond();
    }

    // Règle 4 — idempotence : déjà traité
    if (payment.status === 'completed') {
      return respond();
    }

    // Règle 3 — vérification du montant confirmé
    if (confirmedAmount !== payment.amount) {
      console.error(
        `[IPN] montant divergent : confirmé ${confirmedAmount} != attendu ${payment.amount}`
      );
      await Payment.findByIdAndUpdate(payment._id, { status: 'failed' });
      return respond();
    }

    // Règle 4 — transition pending → completed (atomique)
    const updated = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'pending' },
      { status: 'completed', paidAt: new Date(), rawConfirm: confirmData },
      { new: true }
    );

    if (!updated) {
      // Race condition : un autre processus a déjà traité ce paiement
      return respond();
    }

    // Règle 5 — empilage et activation
    await activateSubscription(updated);

    return respond();
  } catch (err) {
    console.error('[IPN] erreur non gérée:', err.message);
    return respond();
  }
});

module.exports = router;
