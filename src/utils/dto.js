'use strict';

const { getPlanLimits } = require('../services/subscriptionService');

// plan_limits renvoyé pour un superadmin (accès total, jamais null)
const SUPERADMIN_PLAN_LIMITS = {
  effective_plan: 'premium',
  max_employees:  -1,
  features: { advanced_stats: true, unlimited_catalog: true, priority_support: true },
};

// plan_limits de repli en cas d'erreur de calcul
const FREE_PLAN_LIMITS = {
  effective_plan: 'free',
  max_employees:  0,
  features: { advanced_stats: false, unlimited_catalog: false, priority_support: false },
};

// ─── Status helpers (commande) ────────────────────────────────────────────────

const STATUS_TO_FR = {
  pending:   'Nouvelle',
  confirmed: 'Confirmée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
};

const STATUS_TO_EN = {
  Nouvelle:  'pending',
  Confirmée: 'confirmed',
  Livrée:    'delivered',
  Annulée:   'cancelled',
};

function statusToFr(en) {
  return STATUS_TO_FR[en] || en;
}

/** Accepte FR ou EN — passe EN tel quel (pas dans le map → fallback). */
function statusToEn(fr) {
  return STATUS_TO_EN[fr] || fr;
}

// ─── Status helpers (paiement) ────────────────────────────────────────────────

const PAYMENT_TO_FR = {
  unpaid:  'En attente de paiement',
  partial: 'Partiel',
  paid:    'Payée',
};

const PAYMENT_TO_EN = {
  'En attente de paiement': 'unpaid',
  Partiel:                  'partial',
  Payée:                    'paid',
};

function paymentToFr(en) {
  return PAYMENT_TO_FR[en] || en;
}

/** Accepte FR ou EN. */
function paymentToEn(fr) {
  return PAYMENT_TO_EN[fr] || fr;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const R2_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

/**
 * Résout l'URL publique d'une image.
 * Priorité : r2Key + R2_PUBLIC_URL_BASE (toujours correct) → url stockée (legacy sans r2Key) → null.
 * L'URL stockée en DB peut être périmée si R2_PUBLIC_URL_BASE a changé ; r2Key est la source de vérité.
 */
function resolveImageUrl(img) {
  if (!img) return null;
  if (img.r2Key && R2_BASE) return `${R2_BASE}/${img.r2Key}`;
  if (img.url && img.url.startsWith('http')) return img.url;
  return null;
}

function performedByToDTO(actor) {
  if (!actor || !actor.actorType) return null;
  return {
    name:  actor.name  || '',
    phone: actor.phone || '',
    type:  actor.actorType,
  };
}

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

// ─── MerchantDTO ─────────────────────────────────────────────────────────────

/**
 * @param {object} merchant        Mongoose doc ou plain object
 * @param {object} [subscription]  Subscription le plus récent (doc ou plain)
 * @param {number} [scansQuota]    Quota effectif depuis PlanConfig (défaut 100)
 * @param {object} [actorOverride] { role, permissions } pour les employés
 * @param {object} [planLimits]    Pré-calculé par l'appelant (perf) ; si absent,
 *                                 calculé automatiquement via getPlanLimits.
 *                                 plan_limits n'est JAMAIS null dans le DTO résultant.
 */
async function toMerchantDTO(merchant, subscription, scansQuota = 100, actorOverride, planLimits) {
  const m = plain(merchant);

  // Calcul automatique si l'appelant n'a pas fourni planLimits
  let limits = planLimits ?? null;
  if (limits === null) {
    if (m.role === 'superadmin') {
      limits = SUPERADMIN_PLAN_LIMITS;
    } else {
      try {
        limits = await getPlanLimits(m._id || m.id);
      } catch {
        limits = FREE_PLAN_LIMITS;
      }
    }
  }

  const scansUsed = m.usage?.scansCurrentMonth || 0;

  // 'merchant' interne → 'owner' dans le DTO
  let role = m.role === 'superadmin' ? 'superadmin' : 'owner';
  let permissions;

  if (actorOverride) {
    role        = actorOverride.role        || role;
    permissions = actorOverride.permissions;
  }

  let subscriptionStatus = 'trial';
  let trialEndsAt        = null;

  if (subscription) {
    const sub = plain(subscription);
    subscriptionStatus = sub.status || 'trial';
    if (sub.status === 'trial' && sub.endDate) {
      trialEndsAt = new Date(sub.endDate).toISOString();
    }
  }

  const dto = {
    id:                      m._id?.toString() || m.id,
    shop_name:               m.businessName    || '',
    owner_name:              m.ownerName       || '',
    logo_url:                m.logoUrl         || null,
    slug:                    m.slug            || '',
    whatsapp_number:         m.whatsappPhone   || '',
    address:                 m.address         || '',
    description:             m.catalogDescription || '',
    role,
    plan:                    m.plan || 'free',
    subscription_status:     subscriptionStatus,
    trial_ends_at:           trialEndsAt,
    quota: {
      scans_used:           scansUsed,
      scans_quota:          scansQuota,
      soft_limit_reached:   scansUsed >= Math.round(scansQuota * 0.8),
      held:                 scansUsed >= scansQuota,
    },
    wakanect_whatsapp_number: process.env.WAKANECT_WHATSAPP_NUMBER || '',
    plan_limits: limits,
  };

  if (permissions !== undefined) dto.permissions = permissions;

  return dto;
}

// ─── ProductDTO ──────────────────────────────────────────────────────────────

function toProductDTO(product) {
  const p = plain(product);

  const primaryImage = (p.images || []).find(img => img.isPrimary) || (p.images || [])[0];
  const imageUrl     = resolveImageUrl(primaryImage) || p.imageUrl || null;

  const images = (p.images || [])
    .map(img => ({ id: img._id?.toString() || img.id?.toString() || null, url: resolveImageUrl(img), isPrimary: !!img.isPrimary }))
    .filter(i => i.url);
  if (!images.length && p.imageUrl) images.push({ id: null, url: p.imageUrl, isPrimary: true });

  // publishedBy (qui a validé) préféré à submittedBy (qui a envoyé le WA)
  const performer = p.publishedBy?.actorType ? p.publishedBy : p.submittedBy;

  return {
    id:           p._id?.toString() || p.id,
    name:         p.name,
    price:        p.price,
    stock:        p.stock,
    category:     p.category     || null,
    image_url:    imageUrl,
    images,
    colors:       p.colors || [],
    sizes:        p.sizes  || [],
    performed_by: performedByToDTO(performer),
  };
}

// ─── OrderDTO ────────────────────────────────────────────────────────────────

function toOrderDTO(order) {
  const o = plain(order);

  const lastActor = [...(o.statusHistory || [])]
    .reverse()
    .find(h => h.performedBy?.actorType && !String(h.status).startsWith('payment:'));

  return {
    id:               o._id?.toString() || o.id,
    customer_name:    o.customer?.name    || '',
    customer_phone:   o.customer?.phone   || '',
    total:            o.totalAmount,
    status:           statusToFr(o.status),
    payment_status:   paymentToFr(o.paymentStatus),
    delivery_address: o.customer?.address || null,
    note:             o.customer?.notes   || null,
    created_at:       o.createdAt ? new Date(o.createdAt).toISOString() : null,
    items: (o.items || []).map(item => ({
      name:     item.productName,
      price:    item.unitPrice,
      quantity: item.quantity,
      color:    item.color || null,
    })),
    performed_by: performedByToDTO(lastActor?.performedBy),
  };
}

// ─── PendingCandidateDTO ─────────────────────────────────────────────────────

function toPendingCandidateDTO(parsedMessage) {
  const m = plain(parsedMessage);

  const dc        = m.duplicateCheck;
  const duplicate = dc?.isDuplicate
    ? {
        confidence:   dc.confidence,
        matched_on:   dc.matchedOn,
        duplicate_of: (dc.duplicateOf || []).map(id => id.toString()),
      }
    : null;

  return {
    id:           m._id?.toString() || m.id,
    raw_text:     m.rawMessage || '',
    timestamp:    m.receivedAt ? new Date(m.receivedAt).toISOString() : null,
    name:         m.product?.name     || '',
    price:        m.product?.price    ?? null,
    quantity:     m.product?.quantity ?? 1,
    category:     m.product?.category || '',
    sizes:        m.product?.sizes    || [],
    colors:       m.product?.colors   || [],
    confidence:   m.confidence        ?? 0,
    images:       (m.images || []).map(resolveImageUrl).filter(Boolean),
    performed_by: performedByToDTO(m.submittedBy),
    duplicate,
  };
}

// ─── BoutiqueDTO ─────────────────────────────────────────────────────────────

function toBoutiqueDTO(merchant, products) {
  const m = plain(merchant);
  return {
    slug:            m.slug,
    shop_name:       m.businessName,
    owner_name:      m.ownerName     || '',
    whatsapp_number: m.whatsappPhone || '',
    banner_url:      m.bannerUrl     || null,
    products:        (products || []).map(toProductDTO),
  };
}

module.exports = {
  toMerchantDTO,
  toProductDTO,
  toOrderDTO,
  toPendingCandidateDTO,
  toBoutiqueDTO,
  statusToFr,
  statusToEn,
  paymentToFr,
  paymentToEn,
};
