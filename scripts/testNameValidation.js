'use strict';

/**
 * WAKANECT — Test unitaire du validateur de nom (garde-fous + décision 3 paliers)
 *
 * Aucun appel réseau ici — on teste la LOGIQUE seule, avant de la brancher sur
 * de vrais appels Workers AI / DeepSeek. Objectif : confirmer que chaque
 * garde-fou rejette bien ce qu'il doit rejeter, et accepte ce qu'il doit
 * accepter, y compris sur les vrais résultats DeepSeek du dernier test.
 *
 * Usage : node scripts/testNameValidation.js
 */

const { resolveNameDecision } = require('../src/services/parsing/nameValidation');

const CASES = [
    // ── Vrais résultats DeepSeek du dernier run — doivent être acceptés ──
    {
        label: 'Ensemble jogging (résultat DeepSeek réel)',
        rawText: "🔥🔥 PROMO ! Ensemble jogging gris et noir 12.500f taille L et XL 🔥 Livraison possible sur Dakar",
        name: "Ensemble jogging gris et noir",
        aiConfidenceLevel: 'HIGH',
        expected: 'accept',
    },
    {
        label: 'Chaussures dames (résultat DeepSeek réel)',
        rawText: "Bonjour à tous, nouvel arrivage de chaussures dames du 37 au 41, très confortables, 9500f",
        name: "chaussures dames",
        aiConfidenceLevel: 'HIGH',
        expected: 'accept',
    },
    {
        label: 'iPhone 13 128Go — le cas qui a révélé le bug du ratio de chiffres',
        rawText: "iPhone 13 128Go 350.000f propre, batterie 89%, vient avec chargeur et boîte d'origine",
        name: "iPhone 13 128Go",
        aiConfidenceLevel: 'HIGH',
        expected: 'accept',
    },

    // ── Chaque garde-fou déterministe doit se déclencher avec la bonne raison ──
    {
        label: 'Nom vide',
        rawText: "Sac à main cuir véritable, 12500f",
        name: '',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'empty',
    },
    {
        label: 'Nom trop court',
        rawText: "Sac à main cuir véritable, 12500f",
        name: 'Le',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'too_short',
    },
    {
        label: 'Prix résiduel dans le nom',
        rawText: "Ensemble jogging 12500f taille L",
        name: 'Ensemble jogging 12500f',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'contains_price',
    },
    {
        label: 'Bruit marketing dans le nom',
        rawText: "Ensemble jogging, livraison possible sur Dakar",
        name: 'Ensemble jogging livraison Dakar',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'contains_marketing_noise',
    },
    {
        label: "Le modèle a recraché le texte brut sans rien isoler",
        rawText: "Sac a main cuir",
        name: 'Sac a main cuir',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'same_as_raw',
    },
    {
        label: 'Placeholder générique halluciné',
        rawText: "Photo floue, texte peu clair 5000f",
        name: 'Produit',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'generic_placeholder',
    },
    {
        label: 'Référence à 5 chiffres qui a fuité dans le nom',
        rawText: "Réf 2024-12345-A disponible 8000f",
        name: 'Réf 2024 12345 A',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse',
        expectedReason: 'too_many_digits',
    },

    // ── Hallucination : le modèle invente une marque absente du texte source ──
    {
        label: "Hallucination — marque inventée, absente du texte",
        rawText: "Sac à main cuir véritable, fait main, 12500f",
        name: 'Sac à main Louis Vuitton édition limitée collector',
        aiConfidenceLevel: 'HIGH',
        expected: 'full_reparse', // overlap trop faible même avec confiance HIGH
    },

    // ── Nom très court, confiance plafonnée par manque de tokens ──
    {
        label: 'Nom à 1 mot — confiance HIGH plafonnée à 70',
        rawText: "Montre 8000fr",
        name: 'Montre',
        aiConfidenceLevel: 'HIGH',
        aiTokenCount: 1,
        expected: 'correction', // pas 'accept' malgré HIGH, à cause du plafond
    },

    // ── Cas à trancher ensemble — voir note après le script ──
    {
        label: 'Confiance LOW mais recouvrement parfait avec le texte (Option B)',
        rawText: "Article difficile à lire, mais on dirait Chaussures Nike homme, 15000f",
        name: 'Chaussures Nike homme',
        aiConfidenceLevel: 'LOW',
        expected: 'correction',
    },
];

function run() {
    console.log('─'.repeat(70));
    console.log('Test du validateur de nom — garde-fous + décision à 3 paliers');
    console.log('─'.repeat(70));

    let passed = 0;
    for (const c of CASES) {
        const result = resolveNameDecision({
            name: c.name,
            rawText: c.rawText,
            aiConfidenceLevel: c.aiConfidenceLevel,
            aiTokenCount: c.aiTokenCount,
        });

        const pathOk = result.path === c.expected;
        const reasonOk = !c.expectedReason || result.reason === c.expectedReason;
        const ok = pathOk && reasonOk;
        if (ok) passed++;

        console.log(`\n${ok ? '✓' : '✗'} ${c.label}`);
        console.log(`   nom="${c.name}"`);
        console.log(`   attendu=${c.expected}${c.expectedReason ? ` (${c.expectedReason})` : ''} → obtenu=${result.path}${result.reason ? ` (${result.reason})` : ''}`);
        if (result.overlap != null) console.log(`   overlap=${result.overlap.toFixed(2)} aiScore=${result.aiScore}`);
    }

    console.log('\n' + '─'.repeat(70));
    console.log(`${passed}/${CASES.length} cas conformes à l'attendu`);
    if (passed < CASES.length) {
        console.log('⚠️  Ne pas brancher tant que tous les cas ne passent pas.');
        process.exitCode = 1;
    }
}

run();