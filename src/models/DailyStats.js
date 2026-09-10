'use strict';

const mongoose = require('mongoose');

const dailyStatsSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    date: { type: String, required: true }, // "YYYY-MM-DD" — clé calendaire, comparable en string (ISO)

    pageViews:        { type: Number, default: 0 },
    productViews:      { type: Number, default: 0 },
    addToCarts:        { type: Number, default: 0 },
    checkoutsStarted:  { type: Number, default: 0 },
    ordersPlaced:      { type: Number, default: 0 },
  },
  { timestamps: true }
);

dailyStatsSchema.index({ merchantId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyStats', dailyStatsSchema);