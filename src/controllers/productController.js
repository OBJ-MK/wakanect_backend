'use strict';

const Product  = require('../models/Product');
const Merchant = require('../models/Merchant');
const { deleteFromR2 }    = require('../services/mediaService');
const { toProductDTO, toBoutiqueDTO } = require('../utils/dto');
const { actorFromReq } = require('../utils/actorResolver');

// ─── Dashboard commerçant ──────────────────────────────────────────────────────

/**
 * GET /api/products  et  GET /api/stock/products
 */
const getProducts = async (req, res) => {
  try {
    const { category, search, lowStock, page = 1, limit = 50 } = req.query;
    const filter = { merchantId: req.merchantId };

    if (category)         filter.category = category;
    if (lowStock === 'true') filter.$expr = { $lte: ['$stock', '$lowStockThreshold'] };
    if (search)           filter.name     = { $regex: search, $options: 'i' };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ category: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json({
      products: products.map(toProductDTO),
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * POST /api/products
 */
const createProduct = async (req, res) => {
  try {
    const { name, price, stock, unit, category, description, sku, isPublished, imageUrl, colors, sizes } = req.body;

    const product = await Product.create({
      merchantId: req.merchantId,
      name,
      price,
      stock:       stock ?? 0,
      unit,
      category,
      description,
      sku,
      isPublished: isPublished ?? false,
      imageUrl,
      colors:      colors || [],
      sizes:       sizes  || [],
    });

    res.status(201).json({ success: true, product: toProductDTO(product) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Un produit avec ce SKU existe déjà' });
    }
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/products/:id
 * Champs modifiables : name, price, description, category, stock, colors, sizes.
 * Tout autre champ (images, sku, isPublished…) est ignoré.
 */
const updateProduct = async (req, res) => {
  try {
    const { name, price, description, category, stock, colors, sizes } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: 'Le nom du produit ne peut pas être vide' });
      }
      updates.name = String(name).trim();
    }
    if (price !== undefined) {
      const n = Number(price);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ error: 'Le prix doit être un nombre >= 0' });
      }
      updates.price = n;
    }
    if (stock !== undefined) {
      const n = Number(stock);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ error: 'Le stock doit être un nombre >= 0' });
      }
      updates.stock = n;
    }
    if (description !== undefined) updates.description = description;
    if (category    !== undefined) updates.category    = category || null;
    if (colors      !== undefined) updates.colors      = Array.isArray(colors) ? colors : [];
    if (sizes       !== undefined) updates.sizes       = Array.isArray(sizes)  ? sizes  : [];

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.merchantId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ success: true, product: toProductDTO(product) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /api/products/:id
 */
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({
      _id: req.params.id,
      merchantId: req.merchantId,
    });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ success: true, message: 'Produit supprimé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Catalogue public ──────────────────────────────────────────────────────────

/**
 * GET /api/boutique/:slug
 * Retourne BoutiqueDTO : tableau plat products[], pas groupé par catégorie.
 */
const getPublicCatalogue = async (req, res) => {
  try {
    const merchant = await Merchant.findOne({
      slug: req.params.slug,
      isActive: true,
    }).lean();

    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    const products = await Product.find({
      merchantId:  merchant._id,
      isPublished: true,
      stock:       { $gt: 0 },
    })
      .sort({ category: 1, name: 1 })
      .lean();

    res.json(toBoutiqueDTO(merchant, products));
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ─── Gestion images produit ────────────────────────────────────────────────────

/**
 * DELETE /api/products/:id/images/:imageId
 */
const deleteProductImage = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      merchantId: req.merchantId,
    });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    const image = product.images.id(req.params.imageId);
    if (!image)   return res.status(404).json({ error: 'Image non trouvée' });

    const { r2Key, isPrimary } = image;
    image.deleteOne();

    if (isPrimary && product.images.length > 0) {
      product.images[0].isPrimary = true;
    }

    await product.save();

    if (r2Key) {
      deleteFromR2(r2Key).catch(err =>
        console.error(`[R2] Erreur suppression ${r2Key}:`, err.message)
      );
    }

    res.json({ success: true, product: toProductDTO(product) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/products/:id/images/:imageId/primary
 */
const setProductImagePrimary = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      merchantId: req.merchantId,
    });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    const target = product.images.id(req.params.imageId);
    if (!target)  return res.status(404).json({ error: 'Image non trouvée' });

    for (const img of product.images) {
      img.isPrimary = img._id.equals(target._id);
    }

    await product.save();
    res.json({ success: true, product: toProductDTO(product) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getPublicCatalogue,
  deleteProductImage,
  setProductImagePrimary,
};
