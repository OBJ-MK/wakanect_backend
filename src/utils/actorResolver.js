const Merchant = require('../models/Merchant');

/**
 * Resolve a normalized sender phone to { merchant, actor }.
 * Searches owner phone first, then active employees.
 * Returns null if no match.
 *
 * actor shape: { actorType: 'owner'|'employee', actorId, name, phone }
 */
const resolveSenderActor = async (phone) => {
  const merchant = await Merchant.findOne({
    isActive: true,
    $or: [
      { whatsappPhone: phone },
      { employees: { $elemMatch: { phone, active: true } } },
    ],
  });

  if (!merchant) return null;

  if (merchant.whatsappPhone === phone) {
    return {
      merchant,
      actor: {
        actorType: 'owner',
        actorId: merchant._id.toString(),
        name: merchant.ownerName || merchant.businessName,
        phone,
      },
    };
  }

  const employee = merchant.employees.find((e) => e.phone === phone && e.active);
  // Guard: should always be found given the query above matched, but be safe
  if (!employee) return null;

  return {
    merchant,
    actor: {
      actorType: 'employee',
      actorId: employee._id.toString(),
      name: employee.name,
      phone,
    },
  };
};

/**
 * Build a performedBy object from req.actor (JWT-injected by authMiddleware).
 */
const actorFromReq = (req) => ({
  actorType: req.actor?.type,
  actorId: req.actor?.id,
  name: req.actor?.name,
  phone: req.actor?.phone,
});

module.exports = { resolveSenderActor, actorFromReq };
