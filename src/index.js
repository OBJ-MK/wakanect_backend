require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../config/database');

const webhookRoutes = require('./routes/webhook');
const stockRoutes = require('./routes/stock');
const apiRoutes = require('./routes/api');
const merchantRoutes = require('./routes/merchants');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares ───────────────────────────────────────────────────────────────

// Capturer le rawBody pour la vérification HMAC du webhook Meta
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'wakanect-backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

// Webhook WhatsApp Meta
app.use('/webhook', webhookRoutes);

// API Stock (dashboard)
app.use('/api/stock', stockRoutes);

// Inscription / profil commerçant
app.use('/api/merchants', merchantRoutes);

// API Produits, Commandes, Catalogue, Dashboard
app.use('/api', apiRoutes);



// 404
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} non trouvée` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(' Erreur non gérée:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ─── Démarrage ─────────────────────────────────────────────────────────────────

const start = async () => {
  if (process.env.NODE_ENV === 'production' && !process.env.WHATSAPP_APP_SECRET) {
    throw new Error('WHATSAPP_APP_SECRET est requis en production — démarrage refusé');
  }

  await connectDB();
  app.listen(PORT, () => {
    console.log(`\n Wakanect backend démarré sur le port ${PORT}`);
    console.log(` Webhook URL : ${process.env.APP_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(` Environnement : ${process.env.NODE_ENV || 'development'}\n`);
  });
};

start().catch((err) => {
  console.error(' Démarrage échoué:', err.message);
  process.exit(1);
});

module.exports = app;
