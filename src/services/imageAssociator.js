/**
 * imageAssociator — in-memory buffer for images that arrive before their
 * associated text product message (or before upload completes).
 *
 * Two-phase association:
 *   1. When an image upload completes and there IS already a recent
 *      ParsedMessage for the sender → attach directly (caller's job).
 *   2. When an image upload completes but NO recent ParsedMessage exists yet
 *      → bufferImage() stores it here.
 *   3. When a new ParsedMessage is created → flushImages() drains the buffer
 *      and returns any images to attach.
 */

const WINDOW_MS = (parseInt(process.env.ASSOCIATION_WINDOW_S, 10) || 120) * 1000;

// senderPhone → Array<{ imageData, timestamp }>
const _buf = new Map();

function bufferImage(senderPhone, imageData) {
  const arr = _buf.get(senderPhone) || [];
  arr.push({ imageData, timestamp: Date.now() });
  _buf.set(senderPhone, arr);
}

/** Drain all images for senderPhone that are still within the association window. */
function flushImages(senderPhone) {
  const now = Date.now();
  const all = _buf.get(senderPhone) || [];
  const fresh = all.filter(e => now - e.timestamp <= WINDOW_MS);
  _buf.delete(senderPhone);
  return fresh.map(e => e.imageData);
}

/** True if receivedAt (Date or ms) is within the association window from now. */
function isWithinWindow(receivedAt) {
  return Date.now() - new Date(receivedAt).getTime() <= WINDOW_MS;
}

// Prevent unbounded growth on high-volume deployments
setInterval(() => {
  const now = Date.now();
  for (const [phone, arr] of _buf.entries()) {
    const fresh = arr.filter(e => now - e.timestamp <= WINDOW_MS);
    if (fresh.length === 0) _buf.delete(phone);
    else _buf.set(phone, fresh);
  }
}, 60_000).unref();

module.exports = { bufferImage, flushImages, isWithinWindow };
