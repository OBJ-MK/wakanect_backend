'use strict';

const Product       = require('../models/Product');
const ParsedMessage = require('../models/ParsedMessage');
const PendingMedia  = require('../models/PendingMedia');
const { actorFromReq } = require('../utils/actorResolver');
const { toPendingCandidateDTO, resolveImageUrl } = require('../utils/dto');
const { checkDuplicate }        = require('../services/duplicateService');
const { deleteFromR2 }          = require('../services/mediaService');

const MAX_IMAGES_PER_PRODUCT = 10;

// ─── Helpers apply ────────────────────────────────────────────────────────────

async function applyNewFormat(parsed, body, merchantId, publishedBy, results) {
  const { name, price, quantity, category, colors, sizes, variants } = body;
  const finalName     = name     || parsed.product.name;
  const finalPrice    = price    != null ? Number(price)    : (parsed.product.price    || 0);
  const finalQuantity = quantity != null ? Number(quantity) : (parsed.product.quantity || 0);
  const finalCategory = category || parsed.product.category || null;
  const finalColors   = colors   || parsed.product.colors   || [];
  const finalSizes    = sizes    || parsed.product.sizes    || [];
  // Si variantes couleur fournies : stock global = somme des quantités
  const finalVariants = Product.sanitizeVariants(variants);

  try {
    await Product.create({
      merchantId,
      name:        finalName,
      price:       finalPrice,
      stock:       finalVariants.length > 0
        ? finalVariants.reduce((sum, v) => sum + v.quantity, 0)
        : finalQuantity,
      unit:        parsed.product.unit || 'pièce',
      category:    finalCategory,
      sku:         parsed.product.sku || undefined,
      colors:      finalColors,
      sizes:       finalSizes,
      variants:    finalVariants,
      images:      parsed.images || [],
      isPublished: true,
      submittedBy: parsed.submittedBy,
      publishedBy,
    });
    results.created = 1;
  } catch (err) {
    console.error('[applyNewFormat] Product.create failed:', err.message);
    results.errors.push(err.code === 11000 ? `SKU déjà utilisé : ${parsed.product.sku}` : err.message);
  }
}

function buildStockUpdateOp(item, finalQty, finalPrice, publishedBy) {
  const op = {};
  if (item.action === 'set_stock')           op.$set = { stock: finalQty };
  else if (item.action === 'add_stock')      op.$inc = { stock: finalQty };
  else if (item.action === 'subtract_stock') op.$inc = { stock: -finalQty };
  if (finalPrice != null) op.$set = { ...op.$set, price: finalPrice, publishedBy };
  return op;
}

async function applyLegacyFormat(parsed, merchantId, publishedBy, results) {
  for (const item of parsed.parsedItems || []) {
    if (item.lineStatus === 'rejected') continue;

    const finalName  = item.correctedProductName || item.productName;
    const finalQty   = item.correctedQuantity ?? item.quantity;
    const finalPrice = item.correctedPrice ?? item.price;

    try {
      if (item.matchedProductId && item.matchConfidence !== 'none') {
        const updateOp = buildStockUpdateOp(item, finalQty, finalPrice, publishedBy);
        await Product.findOneAndUpdate({ _id: item.matchedProductId, merchantId }, updateOp, { new: true });
        await Product.updateOne({ _id: item.matchedProductId, merchantId, stock: { $lt: 0 } }, { $set: { stock: 0 } });
        item.lineStatus = 'applied';
        results.updated++;
      } else if (item.action === 'new_product') {
        await Product.create({
          merchantId,
          name: finalName,
          sku:  item.sku,
          stock: finalQty,
          unit: item.unit,
          price: finalPrice || 0,
          isPublished: true,
          submittedBy: parsed.submittedBy,
          publishedBy,
        });
        item.lineStatus = 'applied';
        results.created++;
      }
    } catch (err) {
      item.lineStatus = 'pending';
      results.errors.push(`${finalName} : ${err.message}`);
    }
  }
}

// ─── POST /api/stock/apply/:parsedMessageId ───────────────────────────────────

const applyParsedMessage = async (req, res) => {
  try {
    const { parsedMessageId } = req.params;
    const merchantId  = req.merchantId;
    const publishedBy = actorFromReq(req);

    const parsed = await ParsedMessage.findOne({ _id: parsedMessageId, merchantId });
    if (!parsed)                      return res.status(404).json({ error: 'Message non trouvé' });
    if (parsed.status === 'applied')  return res.status(400).json({ error: 'Ce message a déjà été appliqué' });

    const results = { updated: 0, created: 0, errors: [] };

    if (parsed.product?.name) {
      await applyNewFormat(parsed, req.body, merchantId, publishedBy, results);
    } else {
      await applyLegacyFormat(parsed, merchantId, publishedBy, results);
    }

    const nothingDone = results.created === 0 && results.updated === 0;
    parsed.status        = results.errors.length > 0 ? 'partially_applied' : 'applied';
    parsed.reviewedBy    = req.actor?.type || 'merchant';
    parsed.reviewedAt    = new Date();
    parsed.appliedSummary = {
      productsUpdated: results.updated,
      productsCreated: results.created,
      errors:          results.errors,
    };
    await parsed.save();

    if (nothingDone && results.errors.length > 0) {
      return res.status(422).json({
        success: false,
        status:  parsed.status,
        error:   results.errors[0],
        summary: results,
      });
    }

    res.json({ success: true, status: parsed.status, summary: results });
  } catch (err) {
    console.error('[applyParsedMessage]:', err.message);
    res.status(500).json({ error: "Erreur serveur lors de l'application du stock" });
  }
};

// ─── POST /api/stock/ignore/:parsedMessageId ──────────────────────────────────

const ignoreMessage = async (req, res) => {
  try {
    const parsed = await ParsedMessage.findOne({
      _id:        req.params.parsedMessageId,
      merchantId: req.merchantId,
    });

    if (!parsed) return res.status(404).json({ error: 'Candidat introuvable' });

    if (parsed.status !== 'ignored') {
      parsed.status     = 'ignored';
      parsed.reviewedAt = new Date();
      parsed.reviewedBy = req.actor?.type || 'merchant';
      await parsed.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[ignoreMessage]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── GET /api/stock/pending ───────────────────────────────────────────────────

const getPendingMessages = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const messages = await ParsedMessage.find({
      merchantId: req.merchantId,
      status:     'pending_review',
    })
      .sort({ confidence: 1, receivedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json(messages.map(toPendingCandidateDTO));
  } catch (err) {
    console.error('[getPendingMessages]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── GET /api/stock/orphan-media ──────────────────────────────────────────────

/**
 * Images orphelines "à rattacher" du marchand (ambiguïté webhook : ≥2 candidats
 * en vol au moment de la réception). Le marchand tranche via l'attach ci-dessous.
 */
const getOrphanMedia = async (req, res) => {
  try {
    const orphans = await PendingMedia.find({ merchantId: req.merchantId })
      .sort({ waTimestamp: 1, receivedAt: 1 })
      .lean();

    res.json(orphans.map((o) => ({
      media_id:    o.mediaId,
      url:         resolveImageUrl(o),
      received_at: (o.waTimestamp || o.receivedAt)
        ? new Date(o.waTimestamp || o.receivedAt).toISOString()
        : null,
    })));
  } catch (err) {
    console.error('[getOrphanMedia]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── POST /api/stock/orphan-media/attach ──────────────────────────────────────

/**
 * Body : { mediaId, candidateId } — attache une image orpheline au candidat
 * choisi par le marchand (résout l'ambiguïté), puis la retire de la zone.
 */
const attachOrphanMedia = async (req, res) => {
  try {
    const { mediaId, candidateId } = req.body;
    if (!mediaId || !candidateId) {
      return res.status(400).json({ error: 'mediaId et candidateId requis' });
    }

    const orphan = await PendingMedia.findOne({ merchantId: req.merchantId, mediaId });
    if (!orphan) return res.status(404).json({ error: 'Image orpheline introuvable' });

    const candidate = await ParsedMessage.findOne({ _id: candidateId, merchantId: req.merchantId });
    if (!candidate) return res.status(404).json({ error: 'Candidat introuvable' });
    if (candidate.images.length >= MAX_IMAGES_PER_PRODUCT) {
      return res.status(400).json({ error: `Ce candidat a déjà ${MAX_IMAGES_PER_PRODUCT} images` });
    }

    const o = orphan.toObject();
    candidate.images.push({
      url:              o.url,
      r2Key:            o.r2Key,
      mediaId:          o.mediaId,
      mimeType:         o.mimeType,
      originalMimeType: o.originalMimeType,
      width:            o.width,
      height:           o.height,
      sha256:           o.sha256,
      phash:            o.phash,
      submittedBy:      o.submittedBy,
      receivedAt:       o.receivedAt,
      waTimestamp:      o.waTimestamp,
      isPrimary:        candidate.images.length === 0,
    });
    await candidate.save();
    await orphan.deleteOne();

    // Re-lance la détection anti-doublons (l'image est le signal décisif)
    setImmediate(() =>
      checkDuplicate(candidate._id, candidate.merchantId).catch(err =>
        console.error('[dedup] checkDuplicate error:', err.message)
      )
    );

    res.json({
      success: true,
      candidate_id: candidate._id.toString(),
      image_url: resolveImageUrl(o),
    });
  } catch (err) {
    console.error('[attachOrphanMedia]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── DELETE /api/stock/orphan-media/:mediaId ──────────────────────────────────

/**
 * Supprime définitivement une image orpheline (le texte du produit a été
 * ignoré/supprimé : la photo n'a plus de parent). Retire le PendingMedia et
 * l'objet R2 associé (best-effort : la suppression R2 ne bloque pas la réponse).
 */
const deleteOrphanMedia = async (req, res) => {
  try {
    const { mediaId } = req.params;

    const orphan = await PendingMedia.findOneAndDelete({ merchantId: req.merchantId, mediaId });
    if (!orphan) return res.status(404).json({ error: 'Image orpheline introuvable' });

    if (orphan.r2Key) {
      deleteFromR2(orphan.r2Key).catch(err =>
        console.error(`[deleteOrphanMedia] R2 delete failed (${orphan.r2Key}):`, err.message)
      );
    }

    res.json({ success: true, media_id: mediaId });
  } catch (err) {
    console.error('[deleteOrphanMedia]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── PATCH /api/stock/products/:productId/stock ───────────────────────────────

/**
 * Body : { stock: n, price?: n }  — toujours un set (pas d'incrémentation).
 */
const updateStockManual = async (req, res) => {
  try {
    const { productId } = req.params;
    const merchantId    = req.merchantId;
    const { stock, price } = req.body;

    if (stock === undefined || isNaN(stock)) {
      return res.status(400).json({ error: 'Valeur de stock invalide' });
    }

    const qty       = Math.max(0, parseFloat(stock));
    const setFields = { stock: qty };
    if (price !== undefined && !isNaN(price)) setFields.price = parseFloat(price);

    const product = await Product.findOneAndUpdate(
      { _id: productId, merchantId },
      { $set: setFields },
      { new: true, runValidators: true }
    );

    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    await Product.findByIdAndUpdate(productId, {
      $push: {
        stockHistory: {
          change:      qty - (product.stock + qty - qty), // delta = 0 since we just set it
          newValue:    product.stock,
          performedBy: actorFromReq(req),
          at:          new Date(),
        },
      },
    });

    res.json({ success: true, product });
  } catch (err) {
    console.error('[updateStockManual]:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  applyParsedMessage,
  ignoreMessage,
  updateStockManual,
  getPendingMessages,
  getOrphanMedia,
  attachOrphanMedia,
  deleteOrphanMedia,
};
