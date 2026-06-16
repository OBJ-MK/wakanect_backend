'use strict';

/**
 * Couche d'abstraction PayDunya SoftPay.
 * "PayDunya" n'apparaît jamais dans les réponses destinées à l'UI commerçant.
 *
 * Variables d'environnement attendues :
 *   PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN
 *   PAYDUNYA_MODE = "test" | "live"  (défaut: "test")
 */

const https = require('https');
const http  = require('http');

const MODE = process.env.PAYDUNYA_MODE || 'test';
const BASE = MODE === 'live'
  ? 'https://app.paydunya.com/api/v1'
  : 'https://app.paydunya.com/sandbox-api/v1';

function isConfigured() {
  return !!(
    process.env.PAYDUNYA_MASTER_KEY &&
    process.env.PAYDUNYA_PRIVATE_KEY &&
    process.env.PAYDUNYA_TOKEN
  );
}

function pdRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const url     = new URL(BASE + path);
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(body),
        'PAYDUNYA-MASTER-KEY':  process.env.PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-TOKEN':       process.env.PAYDUNYA_TOKEN,
      },
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Initie un paiement SoftPay (push USSD/Wave).
 *
 * @param {object} opts
 * @param {number} opts.amount         Montant total FCFA
 * @param {string} opts.phone          Numéro du payeur (normalisé, sans +)
 * @param {string} opts.description    Description lisible de l'abonnement
 * @param {string} opts.callbackUrl    URL de notification PayDunya (webhook backend)
 * @returns {{ handle: string, status: "pending"|"stub" }}
 */
async function initiateSoftPay({ amount, phone, description, callbackUrl }) {
  if (!isConfigured()) {
    return {
      handle: `stub-${Date.now()}`,
      status: 'pending',
      _mode:  'stub',
    };
  }

  const result = await pdRequest('/softpay/request-money', {
    amount,
    description,
    phone:        `+${phone}`,
    callback_url: callbackUrl || '',
    cancel_url:   '',
    return_url:   '',
  });

  if (result.body?.response_code === '00') {
    return {
      handle: result.body.hash || result.body.token,
      status: 'pending',
    };
  }

  throw new Error(result.body?.response_text || 'Erreur PayDunya');
}

module.exports = { initiateSoftPay, isConfigured };
