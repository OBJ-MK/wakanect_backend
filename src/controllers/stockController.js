'use strict';

const Product       = require('../models/Product');
const ParsedMessage = require('../models/ParsedMessage');
const { actorFromReq }          = require('../utils/actorResolver');
const { toPendingCandidateDTO } = require('../utils/dto');

// ─── Helpers apply ────────────────────────────────────────────────────────────

async function applyNewFormat(parsed, body, merchantId, publishedBy, results) {
  const { name, price, quantity, category, colors, sizes } = body;
  const finalName     = name     || parsed.product.name;
  const finalPrice    = price    != null ? Number(price)    : (parsed.product.price    || 0);
  const finalQuantity = quantity != null ? Number(quantity) : (parsed.product.quantity || 0);
  const finalCategory = category || parsed.product.category || null;
  const finalColors   = colors   || parsed.product.colors   || [];
  const finalSizes    = sizes    || parsed.product.sizes    || [];

  try {
    await Product.create({
      merchantId,
      name:        finalName,
      price:       finalPrice,
      stock:       finalQuantity,
      unit:        parsed.product.unit || 'pièce',
      category:    finalCategory,
      sku:         parsed.product.sku || undefined,
      colors:      finalColors,
      sizes:       finalSizes,
      isPublished: false,
      submittedBy: parsed.submittedBy,
      publishedBy,
    });
    results.created = 1;
  } catch (err) {
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
          isPublished: false,
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

    parsed.status        = results.errors.length > 0 ? 'partially_applied' : 'applied';
    parsed.reviewedBy    = req.actor?.type || 'merchant';
    parsed.reviewedAt    = new Date();
    parsed.appliedSummary = {
      productsUpdated: results.updated,
      productsCreated: results.created,
      errors:          results.errors,
    };
    await parsed.save();

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
};
