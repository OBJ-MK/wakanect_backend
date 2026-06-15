const axios = require('axios');

const WA_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v19.0';
const WA_BASE_URL = `https://graph.facebook.com/${WA_API_VERSION}`;

/**
 * Envoie un message texte WhatsApp via Meta Cloud API
 */
const sendTextMessage = async (phoneNumberId, toPhone, text) => {
  try {
    const response = await axios.post(
      `${WA_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.message;
    console.error(' WhatsApp send error:', detail);
    return { success: false, error: detail };
  }
};

/**
 * Notifie le commerçant d'une nouvelle commande
 */
const notifyMerchantNewOrder = async (merchant, order) => {
  const phoneNumberId = merchant.whatsappPhoneId;
  const toPhone = merchant.whatsappPhone;

  if (!phoneNumberId || !toPhone) {
    console.warn(`  Merchant ${merchant.slug} manque phoneNumberId ou phone`);
    return { success: false, error: 'Configuration WhatsApp manquante' };
  }

  const itemsList = order.items
    .map((i) => `  • ${i.productName} × ${i.quantity} = ${i.subtotal.toLocaleString('fr-FR')} ${i.currency}`)
    .join('\n');

  const message =
    ` *Nouvelle commande ${order.orderNumber}*\n\n` +
    ` *Client :* ${order.customer.name}\n` +
    (order.customer.phone ? ` ${order.customer.phone}\n` : '') +
    (order.customer.address ? ` ${order.customer.address}\n` : '') +
    `\n*Produits :*\n${itemsList}\n\n` +
    ` *Total : ${order.totalAmount.toLocaleString('fr-FR')} ${order.currency}*\n\n` +
    (order.customer.notes ? ` Note : ${order.customer.notes}\n\n` : '') +
    ` Voir sur votre dashboard : ${process.env.APP_URL}/dashboard/commandes/${order._id}`;

  return sendTextMessage(phoneNumberId, toPhone, message);
};

/**
 * Envoie un accusé de réception au commerçant après parsing
 */
const acknowledgeStockMessage = async (merchant, summary) => {
  const phoneNumberId = merchant.whatsappPhoneId;
  const toPhone = merchant.whatsappPhone;

  if (!phoneNumberId || !toPhone) return { success: false };

  let message =
    ` *Message stock reçu !*\n\n` +
    ` ${summary.total} produit(s) détecté(s)\n` +
    ` ${summary.matched} correspondance(s) trouvée(s)\n`;

  if (summary.newProducts > 0) {
    message += ` ${summary.newProducts} nouveau(x) produit(s) à créer\n`;
  }
  if (summary.unparsed > 0) {
    message += `  ${summary.unparsed} ligne(s) non reconnue(s)\n`;
  }

  message += `\n Validez sur votre dashboard : ${process.env.APP_URL}/dashboard/stock/validation`;

  return sendTextMessage(phoneNumberId, toPhone, message);
};

module.exports = {
  sendTextMessage,
  notifyMerchantNewOrder,
  acknowledgeStockMessage,
};
