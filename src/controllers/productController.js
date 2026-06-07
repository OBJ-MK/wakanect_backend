const Product = require('../models/Product');
const Merchant = require('../models/Merchant');

// ─── Dashboard commerçant ──────────────────────────────────────────────────────

/**
 * GET /api/products
 * Liste tous les produits du commerçant connecté
 */
const getProducts = async (req, res) => {
  try {
    const { category, search, lowStock, page = 1, limit = 50 } = req.query;
    const filter = { merchantId: req.merchantId };

    if (category) filter.category = category;
    if (lowStock === 'true') filter.$expr = { $lte: ['$stock', '$lowStockThreshold'] };
    if (search) filter.name = { $regex: search, $options: 'i' };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ category: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json({ products, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * POST /api/products
 * Créer un produit manuellement
 */
const createProduct = async (req, res) => {
  try {
    const { name, price, stock, unit, category, description, sku, isPublished, imageUrl } = req.body;

    const product = await Product.create({
      merchantId: req.merchantId,
      name,
      price,
      stock: stock ?? 0,
      unit,
      category,
      description,
      sku,
      isPublished: isPublished ?? false,
      imageUrl,
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Un produit avec ce SKU existe déjà' });
    }
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/products/:id
 * Modifier un produit (nom, prix, catégorie, visibilité...)
 */
const updateProduct = async (req, res) => {
  try {
    const allowed = ['name', 'price', 'unit', 'category', 'description', 'sku', 'isPublished', 'imageUrl', 'lowStockThreshold'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.merchantId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ success: true, product });
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
 * GET /boutique/:slug
 * Catalogue public — accessible sans auth
 */
const getPublicCatalogue = async (req, res) => {
  try {
    const merchant = await Merchant.findOne({
      slug: req.params.slug,
      isActive: true,
    }).lean();

    if (!merchant) return res.status(404).json({ error: 'Boutique introuvable' });

    const products = await Product.find({
      merchantId: merchant._id,
      isPublished: true,
      stock: { $gt: 0 },
    })
      .select('name description price currency unit stock category imageUrl')
      .sort({ category: 1, name: 1 })
      .lean();

    // Grouper par catégorie pour l'affichage
    const catalogue = products.reduce((acc, p) => {
      const cat = p.category || 'Autres';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(p);
      return acc;
    }, {});

    res.json({
      merchant: {
        businessName: merchant.businessName,
        slug: merchant.slug,
        description: merchant.catalogDescription,
        logoUrl: merchant.logoUrl,
        whatsappPhone: merchant.whatsappPhone,
      },
      catalogue,
      totalProducts: products.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getProducts, createProduct, updateProduct, deleteProduct, getPublicCatalogue };
