const Product = require('../models/Product');
const ParsedMessage = require('../models/ParsedMessage');
const { actorFromReq } = require('../utils/actorResolver');

/**
 * Applique les lignes validées d'un ParsedMessage au stock réel
 * Appelé depuis le dashboard après validation du commerçant
 */
const applyParsedMessage = async (req, res) => {
  try {
    const { parsedMessageId } = req.params;
    const merchantId = req.merchantId;
    const publishedBy = actorFromReq(req);

    const parsed = await ParsedMessage.findOne({ _id: parsedMessageId, merchantId });
    if (!parsed) return res.status(404).json({ error: 'Message non trouvé' });

    if (parsed.status === 'applied') {
      return res.status(400).json({ error: 'Ce message a déjà été appliqué' });
    }

    const results = { updated: 0, created: 0, errors: [] };

    for (const item of parsed.parsedItems) {
      if (item.lineStatus === 'rejected') continue;

      const finalName = item.correctedProductName || item.productName;
      const finalQty = item.correctedQuantity ?? item.quantity;
      const finalPrice = item.correctedPrice ?? item.price;

      try {
        if (item.matchedProductId && item.matchConfidence !== 'none') {
          const updateOp = {};

          if (item.action === 'set_stock') {
            updateOp.$set = { stock: finalQty };
          } else if (item.action === 'add_stock') {
            updateOp.$inc = { stock: finalQty };
          } else if (item.action === 'subtract_stock') {
            updateOp.$inc = { stock: -finalQty };
          }

          if (finalPrice !== null && finalPrice !== undefined) {
            updateOp.$set = { ...updateOp.$set, price: finalPrice };
          }

          // Stamp publishedBy on the product
          updateOp.$set = { ...updateOp.$set, publishedBy };

          await Product.findOneAndUpdate(
            { _id: item.matchedProductId, merchantId },
            updateOp,
            { new: true }
          );

          await Product.updateOne(
            { _id: item.matchedProductId, merchantId, stock: { $lt: 0 } },
            { $set: { stock: 0 } }
          );

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

    const allApplied = parsed.parsedItems.every((i) => i.lineStatus === 'applied');
    const someApplied = parsed.parsedItems.some((i) => i.lineStatus === 'applied');

    parsed.status = allApplied ? 'applied' : someApplied ? 'partially_applied' : 'pending_review';
    parsed.reviewedBy = 'merchant';
    parsed.reviewedAt = new Date();
    parsed.appliedSummary = {
      productsUpdated: results.updated,
      productsCreated: results.created,
      errors: results.errors,
    };

    await parsed.save();

    res.json({ success: true, status: parsed.status, summary: results });

  } catch (err) {
    console.error(' applyParsedMessage:', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'application du stock' });
  }
};

/**
 * Modification manuelle du stock d'un produit
 * PATCH /api/stock/products/:productId/stock
 */
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

    if (action === 'set') {
      updateOp = { $set: { stock: Math.max(0, qty) } };
    } else if (action === 'add') {
      updateOp = { $inc: { stock: qty } };
    } else if (action === 'subtract') {
      updateOp = { $inc: { stock: -qty } };
    } else {
      return res.status(400).json({ error: 'Action invalide (set | add | subtract)' });
    }

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

    // Push a stock history entry
    const change = action === 'set' ? product.stock - (product.stock - qty) : (action === 'add' ? qty : -qty);
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

/**
 * Liste les messages parsés en attente de validation
 * GET /api/stock/pending
 */
const getPendingMessages = async (req, res) => {
  try {
    const merchantId = req.merchantId;
    const { page = 1, limit = 10 } = req.query;

    const messages = await ParsedMessage.find({
      merchantId,
      status: 'pending_review',
    })
      .sort({ receivedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .populate('parsedItems.matchedProductId', 'name stock sku');

    const total = await ParsedMessage.countDocuments({ merchantId, status: 'pending_review' });

    res.json({ messages, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { applyParsedMessage, updateStockManual, getPendingMessages };
