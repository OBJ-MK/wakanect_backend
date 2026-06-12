const jwt = require('jsonwebtoken');

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

const signMerchantToken = (merchant) =>
  signToken({
    sub: merchant._id.toString(),
    actorType: 'owner',
    actorId: merchant._id.toString(),
    actorName: merchant.ownerName || merchant.businessName,
  });

const signEmployeeToken = (merchant, employee) =>
  signToken({
    sub: merchant._id.toString(),
    actorType: 'employee',
    actorId: employee._id.toString(),
    actorName: employee.name,
  });

module.exports = { signMerchantToken, signEmployeeToken };
