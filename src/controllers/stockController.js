const Product = require('../models/Product');
const ParsedMessage = require('../models/ParsedMessage');
const { actorFromReq } = require('../utils/actorResolver');

// ─── Helpers apply ────────────────────────────────────────────────────────────

async function applyNewFormat(parsed, body, merchantId, publishedBy, results) {
  const { name, price, quantity, category } = body;
  const finalName     = name     || parsed.product.name;
  const finalPrice    = price    != null ? Number(price)    : (parsed.product.price    || 0);
  const finalQuantity = quantity != null ? Number(quantity) : (parsed.product.quantity || 0);
  const finalCategory = category || parsed.product.category || null;

  try {
    await Product.create({
      merchantId,
      name: finalName,
      price: finalPrice,
      stock: finalQuantity,
      unit: parsed.product.unit || 'pièce',
      category: finalCategory,
      sku: parsed.product.sku || undefined,
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
          sku: item.sku,
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

// ─── Validation dashboard — appliquer un message parsé au stock ────────────────

/**
 * POST /api/stock/apply/:parsedMessageId
 * Body (nouveau format) : { name, price, quantity, category, sizes, colors }
 * Body (ancien format)  : aucun — utilise parsedItems (backward compat)
 */
const applyParsedMessage = async (req, res) => {
  try {
    const { parsedMessageId } = req.params;
    const merchantId = req.merchantId;
    const publishedBy = actorFromReq(req);

    const parsed = await ParsedMessage.findOne({ _id: parsedMessageId, merchantId });
    if (!parsed) return res.status(404).json({ error: 'Message non trouvé' });
    if (parsed.status === 'applied') return res.status(400).json({ error: 'Ce message a déjà été appliqué' });

    const results = { updated: 0, created: 0, errors: [] };

    if (parsed.product?.name) {
      await applyNewFormat(parsed, req.body, merchantId, publishedBy, results);
    } else {
      await applyLegacyFormat(parsed, merchantId, publishedBy, results);
    }

    parsed.status = results.errors.length > 0 ? 'partially_applied' : 'applied';
    parsed.reviewedBy = req.actor?.type || 'merchant';
    parsed.reviewedAt = new Date();
    parsed.appliedSummary = { productsUpdated: results.updated, productsCreated: results.created, errors: results.errors };
    await parsed.save();

    res.json({ success: true, status: parsed.status, summary: results });

  } catch (err) {
    console.error(' applyParsedMessage:', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'application du stock' });
  }
};

// ─── Liste des messages en attente — format attendu par le front-end ───────────

/**
 * GET /api/stock/pending
 * Retourne un tableau plat (non paginé) directement consommable par ValidationPage.
 * Triée par confidence croissante : les incertains (needsReview) apparaissent en premier.
 */
const getPendingMessages = async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const { limit = 50 } = req.query;

    const messages = await ParsedMessage.find({
      merchantId,
      status: 'pending_review',
    })
      .sort({ confidence: 1, receivedAt: -1 }) // incertains en premier
      .limit(parseInt(limit));

    // Transformation vers le format attendu par ValidationPage + ConfidenceBadge
    const pending = messages.map((m) => {
      // Nouveau format avec product candidat
      if (m.product && m.product.name) {
        return {
          id: m._id,
          confidence: m.confidence ?? 0,       // 0–100 (ConfidenceBadge: >=80 high, >=50 medium)
          needsReview: m.needsReview,
          parserTier: m.parserTier,
          missingCritical: m.missingCritical || [],
          rawText: m.rawMessage,
          timestamp: m.receivedAt,
          is_duplicate: false,                  // anti-doublon = tâche séparée
          submittedBy: m.submittedBy,
          // Champs produit directement accessibles par le formulaire du front-end
          name: m.product.name,
          price: m.product.price,
          quantity: m.product.quantity,
          unit: m.product.unit || 'pièce',
          category: m.product.category || '',
          sizes: m.product.sizes || [],
          colors: m.product.colors || [],
          sku: m.product.sku || null,
        };
      }

      // Backward compat — ancien format parsedItems (premier item significatif)
      const item = (m.parsedItems || []).find((i) => i.lineStatus !== 'rejected');
      return {
        id: m._id,
        confidence: 50,                         // valeur par défaut pour l'ancien format
        needsReview: true,
        parserTier: 'regex',
        missingCritical: [],
        rawText: m.rawMessage,
        timestamp: m.receivedAt,
        is_duplicate: false,
        submittedBy: m.submittedBy,
        name: item?.productName || '',
        price: item?.price || null,
        quantity: item?.quantity || null,
        unit: item?.unit || 'pièce',
        category: '',
        sizes: [],
        colors: [],
        sku: item?.sku || null,
      };
    });

    res.json(pending);
  } catch (err) {
    console.error(' getPendingMessages:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── Modification manuelle du stock ──────────────────────────────────────────

const updateStockManual = async (req, res) => {
  try {
    const { productId } = req.params;
    const merchantId = req.merchantId;
    const { stock, action = 'set' } = req.body;

    if (stock === undefined || isNaN(stock)) {
      return res.status(400).json({ error: 'Valeur de stock invalide' });
    }

    const qty = parseFloat(stock);
    let updateOp;

    if (action === 'set')           updateOp = { $set: { stock: Math.max(0, qty) } };
    else if (action === 'add')      updateOp = { $inc: { stock: qty } };
    else if (action === 'subtract') updateOp = { $inc: { stock: -qty } };
    else return res.status(400).json({ error: 'Action invalide (set | add | subtract)' });

    const product = await Product.findOneAndUpdate(
      { _id: productId, merchantId },
      updateOp,
      { new: true, runValidators: true }
    );

    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    if (product.stock < 0) {
      await Product.findByIdAndUpdate(productId, { $set: { stock: 0 } });
      product.stock = 0;
    }

    await Product.findByIdAndUpdate(productId, {
      $push: {
        stockHistory: {
          change: action === 'subtract' ? -qty : qty,
          newValue: product.stock,
          performedBy: actorFromReq(req),
          at: new Date(),
        },
      },
    });

    res.json({ success: true, product });
  } catch (err) {
    console.error(' updateStockManual:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { applyParsedMessage, updateStockManual, getPendingMessages };
