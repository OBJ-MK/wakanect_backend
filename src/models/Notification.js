'use strict';

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    // Cible optionnelle : si actorType/actorId sont renseignés, seul cet acteur voit la
    // notification (ex: candidat de validation réservé aux employés autorisés à publier).
    // Sinon, visible par tous les acteurs de la boutique (owner + employés).
    actorType: { type: String, enum: ['owner', 'employee'], default: null },
    actorId:   { type: String, default: null },

    type:  { type: String, enum: ['order', 'validation', 'stock'], required: true },
    title: { type: String, required: true },
    body:  { type: String, required: true },
    to:    { type: String, default: null }, // route frontend, ex: /app/commandes/:id

    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ merchantId: 1, createdAt: -1 });
notificationSchema.index({ merchantId: 1, read: 1 });

module.exports = mongoose.model('Notification', notificationSchema);