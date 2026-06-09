/**
 * Script de test local — simule des messages WhatsApp entrants
 * 
 * Usage : node scripts/test-webhook.js
 * (Le serveur doit être démarré sur le port 3000)
 */

const BASE_URL = 'http://localhost:3000';

// Payload simulant un message WhatsApp entrant (format Meta Cloud API)
const buildWebhookPayload = (phone, phoneNumberId, messageText) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'ENTRY_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '221700000000',
              phone_number_id: phoneNumberId,
            },
            contacts: [{ profile: { name: 'Test Merchant' }, wa_id: phone }],
            messages: [
              {
                from: phone,
                id: `wamid.test.${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                text: { body: messageText },
                type: 'text',
              },
            ],
          },
        },
      ],
    },
  ],
});

const testCases = [
  {
    name: '  Format valide — mise à jour stock simple',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: `STOCK
Tomates fraîches : 50 kg
Oignons violets : 30 kg
Riz parfumé 5kg : 100 sacs
Huile Dinor 1L : 48 bouteilles`,
  },
  {
    name: '  Format valide — avec prix',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: `STOCK
Tomates : 80 kg | 600 FCFA
Pommes de terre : 50 kg | 450 FCFA/kg`,
  },
  {
    name: '  Format valide — avec SKU',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: `STOCK
[TOM001] Tomates : 60 kg
[OIG001] Oignons : 25 kg
[RIZ-5KG] Riz basmati 5kg : 80 sacs`,
  },
  {
    name: '  Ajout/soustraction de stock',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: `STOCK
+Tomates : 20 kg
-Oignons : 5 kg`,
  },
  {
    name: '  Format invalide — pas de header STOCK',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: 'Tomates : 50 kg\nOignons : 30 kg',
  },
  {
    name: '  Message vide',
    phone: '221700000001',
    phoneNumberId: 'PHONE_ID_001',
    message: 'STOCK\n',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runTests = async () => {
  console.log('  Démarrage des tests webhook Wakanect\n');
  console.log(`  Cible : ${BASE_URL}/webhook\n`);
  console.log('─'.repeat(60));

  for (const testCase of testCases) {
    console.log(`\n  Test : ${testCase.name}`);
    console.log(`   Message : ${testCase.message.replace(/\n/g, ' | ').substring(0, 80)}...`);

    const payload = buildWebhookPayload(
      testCase.phone,
      testCase.phoneNumberId,
      testCase.message
    );

    try {
      const response = await fetch(`${BASE_URL}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      console.log(`   Status : ${response.status} — ${text}`);
    } catch (err) {
      console.log(`     Erreur : ${err.message}`);
      console.log('    Assurez-vous que le serveur est démarré : npm run dev');
    }

    await sleep(500);
  }

  console.log('\n─'.repeat(60));
  console.log('  Tests terminés');
  console.log('  Vérifiez MongoDB Atlas pour voir les ParsedMessages créés\n');
};

runTests();
