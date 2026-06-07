const Product = require('../models/Product');
const ParsedMessage = require('../models/ParsedMessage');

/**
 * Applique les lignes validées d'un ParsedMessage au stock réel
 * Appelé depuis le dashboard après validation du commerçant
 */
const applyParsedMessage = async (req, res) => {
  try {
    const { parsedMessageId } = req.params;
    const merchantId = req.merchantId; // injecté par auth middleware

    const parsed = await ParsedMessage.findOne({ _id: parsedMessageId, merchantId });
    if (!parsed) return res.status(404).json({ error: 'Message non trouvé' });

    if (parsed.status === 'applied') {
      return res.status(400).json({ error: 'Ce message a déjà été appliqué' });
    }

    const results = { updated: 0, created: 0, errors: [] };

    for (const item of parsed.parsedItems) {
      if (item.lineStatus === 'rejected') continue;

      // Utiliser les valeurs corrigées si le commerçant les a modifiées
      const finalName = item.correctedProductName || item.productName;
      const finalQty = item.correctedQuantity ?? item.quantity;
      const finalPrice = item.correctedPrice ?? item.price;

      try {
        if (item.matchedProductId && item.matchConfidence !== 'none') {
          // Mise à jour d'un produit existant
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

          await Product.findOneAndUpdate(
            { _id: item.matchedProductId, merchantId },
            { ...updateOp, $max: { stock: 0 } }, // stock ne peut pas être négatif
            { new: true }
          );

          item.lineStatus = 'applied';
          results.updated++;

        } else if (item.action === 'new_product') {
          // Créer un nouveau produit
          await Product.create({
            merchantId,
            name: finalName,
            sku: item.sku,
            stock: finalQty,
            unit: item.unit,
            price: finalPrice || 0,
            isPublished: false, // le commerçant publie manuellement
          });

          item.lineStatus = 'applied';
          results.created++;
        }
      } catch (err) {
        item.lineStatus = 'pending'; // rollback de la ligne
        results.errors.push(`${finalName} : ${err.message}`);
      }
    }

    // Mettre à jour le statut global
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

    res.json({
      success: true,
      status: parsed.status,
      summary: results,
    });

  } catch (err) {
    console.error(' applyParsedMessage:', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'application du stock' });
  }
};

/**
 * Modification manuelle du stock d'un produit
 * PATCH /api/products/:productId/stock
 */
const updateStockManual = async (req, res) => {
  try {
    const { productId } = req.params;
    const merchantId = req.merchantId;
    const { stock, action = 'set' } = req.body; // action: 'set' | 'add' | 'subtract'

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

    // Empêcher stock négatif
    if (product.stock < 0) {
      await Product.findByIdAndUpdate(productId, { $set: { stock: 0 } });
      product.stock = 0;
    }

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
