/**
 * imageAssociator — in-memory buffer for images that arrive before their
 * associated text product message (or before upload completes).
 *
 * Two-phase association:
 *   1. When an image upload completes and there IS already a recent
 *      ParsedMessage for the sender → attach directly (caller's job).
 *   2. When an image upload completes but NO recent ParsedMessage exists yet
 *      → bufferImage() stores it here.
 *   3. When a new ParsedMessage is created → flushImages() drains ONLY the
 *      images whose WhatsApp timestamp is close to the text message of that
 *      candidate: anterior, or posterior by at most GRACE_AFTER_MS (slow
 *      upload). Images clearly after the text belong to the next product and
 *      stay buffered — never drained wholesale toward one candidate.
 */

// Fenêtre d'association resserrée à 30s (était 120s) : au-delà, deux envois
// sont considérés comme deux produits distincts — évite le mélange d'images
// quand un marchand transfère plusieurs produits à la suite.
const WINDOW_MS = (parseInt(process.env.ASSOCIATION_WINDOW_S, 10) || 30) * 1000;

// Petite grâce APRÈS le texte : une image dont l'upload/le webhook arrive juste
// après la création du candidat lui appartient encore (upload lent, réseau).
// Volontairement bien plus courte que WINDOW_MS : au-delà, l'image annonce le
// produit SUIVANT et doit rester en buffer.
const GRACE_AFTER_MS = (parseInt(process.env.ASSOCIATION_GRACE_AFTER_S, 10) || 10) * 1000;

// senderPhone → Array<{ imageData, waTimestamp, bufferedAt }>
// waTimestamp = timestamp WhatsApp du message image (payload Meta) — sert à
// départager l'appartenance ; bufferedAt = horloge serveur, sert à l'expiration.
const _buf = new Map();

function bufferImage(senderPhone, imageData) {
  const arr = _buf.get(senderPhone) || [];
  arr.push({
    imageData,
    waTimestamp: imageData.waTimestamp ? new Date(imageData.waTimestamp).getTime() : Date.now(),
    bufferedAt: Date.now(),
  });
  _buf.set(senderPhone, arr);
}

/**
 * Drain the images for senderPhone whose WhatsApp timestamp falls in
 * [textTs - WINDOW_MS, textTs + GRACE_AFTER_MS] where textTs is the timestamp
 * of the text message creating the candidate. The GRACE_AFTER_MS tail catches
 * images uploaded/delivered just after the text (slow upload) — without it,
 * such images stayed buffered forever and were silently lost at expiration.
 * Images clearly later than the text belong to the NEXT product: they remain
 * buffered.
 */
function flushImages(senderPhone, textReceivedAt = new Date()) {
  const now = Date.now();
  const textTs = new Date(textReceivedAt).getTime();
  const all = _buf.get(senderPhone) || [];

  const toAttach = [];
  const toKeep = [];
  for (const e of all) {
    if (now - e.bufferedAt > WINDOW_MS) continue; // expiré — abandonné
    if (e.waTimestamp <= textTs + GRACE_AFTER_MS && e.waTimestamp >= textTs - WINDOW_MS) {
      toAttach.push(e);
    } else {
      toKeep.push(e); // image nettement postérieure au texte → produit suivant
    }
  }

  if (toKeep.length > 0) _buf.set(senderPhone, toKeep);
  else _buf.delete(senderPhone);

  return toAttach.map(e => e.imageData);
}

/** True if receivedAt (Date or ms) is within the association window from now. */
function isWithinWindow(receivedAt) {
  return Date.now() - new Date(receivedAt).getTime() <= WINDOW_MS;
}

// Prevent unbounded growth on high-volume deployments
setInterval(() => {
  const now = Date.now();
  for (const [phone, arr] of _buf.entries()) {
    const fresh = arr.filter(e => now - e.bufferedAt <= WINDOW_MS);
    if (fresh.length === 0) _buf.delete(phone);
    else _buf.set(phone, fresh);
  }
}, 60_000).unref();

module.exports = { bufferImage, flushImages, isWithinWindow, WINDOW_MS, GRACE_AFTER_MS };
