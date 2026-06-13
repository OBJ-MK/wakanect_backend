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
    actorPhone: merchant.whatsappPhone,
  });

const signEmployeeToken = (merchant, employee) =>
  signToken({
    sub: merchant._id.toString(),
    actorType: 'employee',
    actorId: employee._id.toString(),
    actorName: employee.name,
    actorPhone: employee.phone,
  });

const signSuperadminToken = (admin) =>
  signToken({
    sub: admin._id.toString(),
    actorType: 'superadmin',
    actorId: admin._id.toString(),
    actorName: admin.ownerName || 'Superadmin',
    actorPhone: admin.whatsappPhone,
  });

// Token d'impersonation : session courte (2h) avec marqueur admin
const signImpersonationToken = (merchant, adminId) =>
  jwt.sign(
    {
      sub: merchant._id.toString(),
      actorType: 'owner',
      actorId: merchant._id.toString(),
      actorName: merchant.ownerName || merchant.businessName,
      actorPhone: merchant.whatsappPhone,
      impersonatedBy: adminId,
    },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );

module.exports = { signMerchantToken, signEmployeeToken, signSuperadminToken, signImpersonationToken };
