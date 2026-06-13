const mongoose = require('mongoose');

/**
 * Reusable performedBy sub-document definition.
 * Spread into any schema that needs an author trace.
 */
const performedBySchema = {
  actorType: { type: String, enum: ['owner', 'employee'] },
  actorId: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String },
  phone: { type: String },
};

module.exports = performedBySchema;
