'use strict';

const Product  = require('../models/Product');
const Merchant = require('../models/Merchant');
const { deleteFromR2, compressImage, uploadToR2 } = require('../services/mediaService');
const { toProductDTO, toBoutiqueDTO } = require('../utils/dto');
const { actorFromReq } = require('../utils/actorResolver');

// Tri des listings : recent | price_asc | price_desc (défaut : catégorie puis nom)
const SORT_MAP = {
  recent:     { createdAt: -1 },
  price_asc:  { price: 1 },
  price_desc: { price: -1 },
};

/** Ajoute le filtre prix { $gte, $lte } sur filter.price si priceMin/priceMax valides. */
function applyPriceFilter(filter, priceMin, priceMax) {
  const price = {};
  const min = Number(priceMin);
  const max = Number(priceMax);
  if (priceMin !== undefined && priceMin !== '' && !isNaN(min)) price.$gte = min;
  if (priceMax !== undefined && priceMax !== '' && !isNaN(max)) price.$lte = max;
  if (Object.keys(price).length > 0) filter.price = price;
}

// ─── Dashboard commerçant ──────────────────────────────────────────────────────

/**
 * GET /api/products  et  GET /api/stock/products
 */
const getProducts = async (req, res) => {
  try {
    const { category, search, lowStock, priceMin, priceMax, sort, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.merchantId };

    if (category)         filter.category = category;
    if (lowStock === 'true') filter.$expr = { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] };
    if (search)           filter.name     = { $regex: search, $options: 'i' };
    applyPriceFilter(filter, priceMin, priceMax);

    const parsedPage  = Math.max(1, parseInt(page)  || 1);
    const parsedLimit = Math.min(50, parseInt(limit) || 20);

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort(SORT_MAP[sort] || { category: 1, name: 1 })
        .skip((parsedPage - 1) * parsedLimit)
        .limit(parsedLimit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const items = products.map(toProductDTO);
    res.json({
      items,
      products: items, // alias legacy — clients déployés avant la pagination numérotée
      total,
      page:    parsedPage,
      pages:   Math.max(1, Math.ceil(total / parsedLimit)),
      limit:   parsedLimit,
      hasMore: parsedPage * parsedLimit < total,
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
    const { name, price, wholesalePrice, stock, unit, category, description, sku, isPublished, imageUrl, colors, sizes, variants } = req.body;

    // Si variantes couleur fournies : stock global = somme des quantités
    const cleanVariants = Product.sanitizeVariants(variants);

    const product = await Product.create({
      merchantId: req.merchantId,
      name,
      price,
      wholesalePrice: Number(wholesalePrice) > 0 ? Number(wholesalePrice) : undefined,
      stock:       cleanVariants.length > 0
        ? cleanVariants.reduce((sum, v) => sum + v.quantity, 0)
        : (stock ?? 0),
      unit,
      category,
      description,
      sku,
      isPublished: isPublished ?? false,
      imageUrl,
      colors:      colors || [],
      sizes:       sizes  || [],
      variants:    cleanVariants,
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
 * Champs modifiables : name, price, description, category, stock, colors, sizes, variants.
 * Tout autre champ (images, sku, isPublished…) est ignoré.
 */
const updateProduct = async (req, res) => {
  try {
    const { name, price, wholesalePrice, description, category, stock, colors, sizes, variants } = req.body;
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
    if (wholesalePrice !== undefined) {
      // null / '' / 0 = retirer le prix en gros
      const n = Number(wholesalePrice);
      if (wholesalePrice === null || wholesalePrice === '' || n === 0) {
        updates.wholesalePrice = null;
      } else if (isNaN(n) || n < 0) {
        return res.status(400).json({ error: 'Le prix en gros doit être un nombre >= 0' });
      } else {
        updates.wholesalePrice = n;
      }
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
    if (variants    !== undefined) {
      const cleanVariants = Product.sanitizeVariants(variants);
      updates.variants = cleanVariants;
      // Si variantes présentes : stock global = somme (prime sur le stock fourni)
      if (cleanVariants.length > 0) {
        updates.stock = cleanVariants.reduce((sum, v) => sum + v.quantity, 0);
      }
    }

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
 * GET /api/boutique/:slug?page=1&limit=24
 * Retourne BoutiqueDTO paginé : tableau plat products[], pas groupé par catégorie.
 * Le champ `hasMore` indique s'il reste des produits à charger (infinite scroll).
 */
const getPublicCatalogue = async (req, res) => {
  try {
    const merchant = await Merchant.findOne({ slug: req.params.slug, isActive: true })
      .select('businessName slug ownerName whatsappPhone bannerUrl logoUrl catalogDescription')
      .lean();

    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    const { page = 1, limit = 20, category, search, priceMin, priceMax, sort } = req.query;
    const parsedPage  = Math.max(1, parseInt(page)  || 1);
    const parsedLimit = Math.min(50, parseInt(limit) || 20);

    const filter = { merchantId: merchant._id, isPublished: true, stock: { $gt: 0 } };
    if (category) filter.category = category;
    if (search)   filter.name = { $regex: search, $options: 'i' };
    applyPriceFilter(filter, priceMin, priceMax);

    const [products, total] = await Promise.all([
      Product.find(filter)
        // Seulement les champs utilisés par le storefront — exclut sha256/phash/stockHistory/etc.
        .select('name price stock category imageUrl images.url images.r2Key images.isPrimary colors sizes variants submittedBy publishedBy')
        .sort(SORT_MAP[sort] || { category: 1, name: 1 })
        .skip((parsedPage - 1) * parsedLimit)
        .limit(parsedLimit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const dto = toBoutiqueDTO(merchant, products);
    res.json({
      ...dto,
      items:   dto.products,
      total,
      page:    parsedPage,
      pages:   Math.max(1, Math.ceil(total / parsedLimit)),
      hasMore: parsedPage * parsedLimit < total,
    });
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

/**
 * POST /api/products/:id/images
 */
const uploadProductImage = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });
  try {
    const product = await Product.findOne({ _id: req.params.id, merchantId: req.merchantId });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    const { buffer } = await compressImage(req.file.buffer);
    const { url, r2Key } = await uploadToR2(buffer, {
      merchantId: req.merchantId,
      folder: `merchants/${req.merchantId}/products/${product._id}`,
    });

    const isPrimary = product.images.length === 0;
    product.images.push({ url, r2Key, isPrimary, mimeType: 'image/webp' });
    await product.save();

    res.json({ product: toProductDTO(product) });
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
  uploadProductImage,
};
