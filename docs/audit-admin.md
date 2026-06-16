# Audit API Admin — écarts backend ↔ frontend

> Référence frontend : `wakanect-frontend/src/services/adminApi.js`  
> Référence pages JSX : `src/pages/admin/*.jsx`  
> Date : 2026-06-16

---

## Récapitulatif

| Réf | Endpoint | Champ | Valeur backend (avant) | Valeur attendue frontend | Corrigé |
|-----|----------|-------|------------------------|--------------------------|---------|
| EC-01 | `GET /parsing/events` | `rows[].confidence` | 0–100 (confidenceScore brut) | 0–1 (front multiplie × 100 pour l'affichage %) | ✅ |
| EC-02 | `GET /boutiques` | `rows[].haikuUsage` | string label `'none'`/`'low'`/`'mid'`/`'high'` | number (appels/jour sur 30 j) | ✅ |
| EC-03 | `GET /boutiques` | `rows[].status` | sub.status brut (`'trial'`, `'none'`, `'past_due'`) | `'active'` \| `'suspended'` \| `'dormant'` | ✅ |
| EC-04 | `GET /boutiques?plan=` | filtre plan | `plan=business` → 0 résultats (DB contient `'premium'`) | mapper `'business'` → `'premium'` en entrée | ✅ |
| EC-05 | `GET /boutiques/:slug` | forme globale | `{ merchant: {...}, stats: {...} }` imbriqué | objet plat (`boutique.id`, `boutique.name`, …) | ✅ |
| EC-06 | `GET /boutiques/:slug` | champs manquants | — | `status`, `products`, `name`, `stats.haikuPerDay`, `employees[].productsSent`, `subscription.renewal`, `subscription.paymentStatus` | ✅ |
| EC-07 | `GET /employes` | `rows[]` | `productsSent`, `ordersAccepted`, `lastAction` absents | calculés via ParsedMessage + Order.statusHistory | ✅ |
| EC-08 | `GET /abonnements` | `mrrByCountry` | `{ SN: x, ML: x }` (objet) | `[{ country, mrr }]` (tableau pour BarChart) | ✅ |
| EC-09 | `GET /abonnements` | `rows[].paymentStatus` | sub.status brut (`'active'`, `'trial'`, …) | label FR : `'Payé'` \| `'En attente'` \| `'Impayé'` | ✅ |
| EC-10 | `GET /sante` | `r2.estimatedMb` | clé `estimatedMb` | clé `mb` | ✅ |
| EC-11 | `GET /sante` | `logs[].level` | `'warning'` | `'warn'` (front compare `=== 'warn'`) | ✅ |

---

## Détail par fichier corrigé

### `src/controllers/admin/parsingController.js`
**EC-01** — `getEvents` : `confidence` divisé par 100 (0–100 DB → 0–1 pour le front qui affiche `(val*100).toFixed(0)%`).

### `src/controllers/admin/boutiquesController.js`
**EC-02** — `listBoutiques` : `haikuUsage` → `Math.round(haikuCount30d / 30)` (calls / jour).  
**EC-03** — `listBoutiques` : `status` → mapping tristate :
  - `isActive === false` → `'suspended'`
  - `sub.status` in `['trial','active']` → `'active'`
  - sinon → `'dormant'`  

**EC-04** — `listBoutiques` : filtre `plan=business` mappé → `'premium'` avant la requête Mongo.  
**EC-05 + EC-06** — `getBoutique` : réponse aplatie + champs ajoutés :
  - `name` ← `businessName`
  - `status` ← calculé (même règle EC-03)
  - `products` ← `usage.scansCurrentMonth`
  - `stats.haikuPerDay` ← `haikuCalls30d / 30`
  - `employees[].productsSent` ← aggregation ParsedMessage par téléphone
  - `subscription.renewal` ← alias de `endDate`
  - `subscription.paymentStatus` ← map FR : `trial`→`'En attente'`, `active`→`'Payé'`, `past_due|canceled`→`'Impayé'`

### `src/controllers/admin/employesController.js`
**EC-07** — `listEmployes` : 3 aggregations en parallèle (ParsedMessage, Order.statusHistory, ParsedMessage pour lastAction).

### `src/controllers/admin/abonnementsController.js`
**EC-08** — `getAbonnements` : `mrrByCountry` converti en `[{ country, mrr }]`.  
**EC-09** — `getAbonnements` : `rows[].paymentStatus` mappé en label FR.

### `src/controllers/admin/santeController.js`
**EC-10** — `getSante` : `r2.estimatedMb` → `r2.mb`.  
**EC-11** — `getSante` : `logs[].level: 'warning'` → `'warn'`.

---

## Aucun écart

- `GET /overview` — shapes identiques.
- `GET /parsing/funnel` — shapes identiques.
- `GET /parsing/top` — shapes identiques.
- `GET /parsing/events.csv` — pas de shape JSON (CSV brut).
- `GET /audit` — shapes identiques.
- `POST /boutiques/:id/*` (suspend, extend-trial, change-plan, reset-password, impersonate) — shapes OK.

---

## Convention plan

Le backend émet toujours `'pro'` | `'premium'` | `'free'`. Le frontend v1 utilisait `'business'` pour premium :  
→ EC-04 mappait le filtre entrant `business` → `premium`.  
→ Le badge `<AdminBadge variant="premium">` reste à corriger côté frontend (hors scope backend).
