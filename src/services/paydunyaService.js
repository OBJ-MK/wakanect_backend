'use strict';

/**
 * Couche d'abstraction PAR (Paiement Avec Redirection) — usage interne uniquement.
 * "PayDunya" n'apparaît jamais dans les réponses destinées à l'UI commerçant.
 *
 * Variables d'environnement attendues :
 *   PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN
 *   PAYDUNYA_MODE = "test" | "live"  (défaut: "test")
 */

const crypto = require('crypto');

const MODE = process.env.PAYDUNYA_MODE || 'test';
const BASE = MODE === 'live'
  ? 'https://app.paydunya.com/api/v1'
  : 'https://app.paydunya.com/sandbox-api/v1';

const PERIOD_LABEL = {
  monthly:    '1 mois',
  quarterly:  '3 mois',
  semiannual: '6 mois',
  annual:     '12 mois',
};

function pdHeaders() {
  return {
    'Content-Type':         'application/json',
    'PAYDUNYA-MASTER-KEY':  process.env.PAYDUNYA_MASTER_KEY  || '',
    'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY || '',
    'PAYDUNYA-TOKEN':       process.env.PAYDUNYA_TOKEN        || '',
  };
}

/**
 * Crée une facture checkout PAR.
 * Retourne { token, url }.
 */
async function createCheckoutInvoice({ merchant, plan, period, amount, paymentId }) {
  const planLabel   = plan === 'pro' ? 'Pro' : 'Premium';
  const periodLabel = PERIOD_LABEL[period] || period;

  const payload = {
    invoice: {
      total_amount: amount,
      description:  `Abonnement Wakanect ${planLabel} — ${periodLabel}`,
    },
    store: {
      name:        'Wakanect',
      logo_url:    process.env.STORE_LOGO_URL   || '',
      website_url: process.env.FRONTEND_URL     || '',
    },
    actions: {
      return_url:   `${process.env.FRONTEND_URL || ''}/abonnement/succes`,
      cancel_url:   `${process.env.FRONTEND_URL || ''}/abonnement/annule`,
      callback_url: `${process.env.APP_URL      || ''}/api/paydunya/ipn`,
    },
    custom_data: {
      merchantId: String(merchant._id),
      plan,
      period,
      paymentId:  String(paymentId),
    },
  };

  const resp = await fetch(`${BASE}/checkout-invoice/create`, {
    method:  'POST',
    headers: pdHeaders(),
    body:    JSON.stringify(payload),
  });

  const data = await resp.json();

  if (String(data.response_code) !== '00') {
    throw new Error(data.response_text || `Erreur création facture (HTTP ${resp.status})`);
  }

  return {
    token: data.token,
    url:   data.invoice_url || data.response_text,
  };
}

/**
 * Vérifie le hash IPN PayDunya en timing-safe.
 * Le hash attendu = sha512(PAYDUNYA_MASTER_KEY).
 * Retourne false si longueurs différentes ou hash invalide.
 */
function verifyIpnHash(receivedHash) {
  if (!receivedHash || typeof receivedHash !== 'string') return false;

  const expected = crypto
    .createHash('sha512')
    .update(process.env.PAYDUNYA_MASTER_KEY || '')
    .digest('hex');

  try {
    const expBuf = Buffer.from(expected,      'hex');
    const recBuf = Buffer.from(receivedHash,  'hex');
    if (expBuf.length !== recBuf.length) return false;
    return crypto.timingSafeEqual(expBuf, recBuf);
  } catch {
    return false;
  }
}

/**
 * Re-confirme une facture auprès de PayDunya (server-to-server).
 * Retourne le body JSON brut (ne lève pas d'exception sur statut != completed).
 */
async function confirmInvoice(token) {
  const resp = await fetch(
    `${BASE}/checkout-invoice/confirm/${encodeURIComponent(token)}`,
    { method: 'GET', headers: pdHeaders() }
  );

  if (!resp.ok) {
    throw new Error(`confirm HTTP ${resp.status}`);
  }

  return resp.json();
}

module.exports = { createCheckoutInvoice, verifyIpnHash, confirmInvoice };
