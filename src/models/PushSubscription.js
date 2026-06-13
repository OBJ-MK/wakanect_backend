const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    actorType: {
      type: String,
      enum: ['owner', 'employee'],
      required: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Objet subscription Web Push complet (endpoint + keys)
    subscription: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: true }
);

// Unicité par endpoint — upsert safe
pushSubscriptionSchema.index(
  { merchantId: 1, 'subscription.endpoint': 1 },
  { unique: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
