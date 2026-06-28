const crypto = require('crypto');
const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const WA_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v19.0';
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_WIDTH = 1280;

// Lazy-init so missing env vars only blow up when actually used
let _r2;
function r2() {
  if (!_r2) {
    _r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _r2;
}

// ─── Meta media download ──────────────────────────────────────────────────────

async function getMetaMediaInfo(mediaId) {
  const { data } = await axios.get(
    `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
  );
  return { url: data.url, mimeType: data.mime_type };
}

// Returns { buffer, mimeType } or throws Error with code 'unsupported_mime'
async function downloadMetaMedia(mediaId) {
  const { url, mimeType } = await getMetaMediaInfo(mediaId);

  if (!ACCEPTED_MIME.has(mimeType)) {
    const err = new Error(`Type de média non supporté : ${mimeType}`);
    err.code = 'unsupported_mime';
    throw err;
  }

  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    // Meta requires the same bearer token to download from the temporary URL
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });

  return { buffer: Buffer.from(data), mimeType };
}

// ─── Sharp compression ────────────────────────────────────────────────────────

async function compressImage(inputBuffer) {
  const pipeline = sharp(inputBuffer).rotate(); // honour EXIF orientation
  const meta = await pipeline.metadata();

  const resized = meta.width > MAX_WIDTH
    ? pipeline.resize(MAX_WIDTH, null, { withoutEnlargement: true })
    : pipeline;

  const { data, info } = await resized
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height };
}

// ─── Empreintes d'image ───────────────────────────────────────────────────────

/**
 * dHash 64 bits (difference hash) — résistant aux compressions légères.
 * Redimensionne en 9×8 niveaux de gris, compare pixels adjacents sur chaque
 * ligne (8 comparaisons × 8 lignes = 64 bits). Stocké en hex 16 chars.
 */
async function computePHash(buffer) {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      if (data[idx] > data[idx + 1]) hash |= 1n << BigInt(row * 8 + col);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

// ─── R2 upload / delete ───────────────────────────────────────────────────────

async function uploadToR2(buffer, { merchantId, parsedMessageId, folder: customFolder } = {}) {
  const folder = customFolder
    ?? (parsedMessageId
      ? `merchants/${merchantId}/products/${parsedMessageId}`
      : `merchants/${merchantId}/pending`);

  const key = `${folder}/${uuidv4()}.webp`;

  await r2().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000',
  }));

  const base = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');
  return { url: `${base}/${key}`, r2Key: key };
}

async function deleteFromR2(r2Key) {
  await r2().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: r2Key,
  }));
}

// ─── Full pipeline ────────────────────────────────────────────────────────────

/**
 * Download from Meta → compress → upload to R2.
 * Returns an image sub-document (without isPrimary — caller sets it).
 *
 * @param {string} mediaId            WhatsApp media ID
 * @param {{ merchantId, parsedMessageId?, submittedBy?, receivedAt? }} opts
 */
async function processMedia(mediaId, opts = {}) {
  const { buffer, mimeType } = await downloadMetaMedia(mediaId);
  const { buffer: compressed, width, height } = await compressImage(buffer);

  // Empreintes calculées sur le binaire compressé (webp) — en parallèle avec l'upload
  const [{ url, r2Key }, sha256, phash] = await Promise.all([
    uploadToR2(compressed, { merchantId: opts.merchantId, parsedMessageId: opts.parsedMessageId }),
    Promise.resolve(crypto.createHash('sha256').update(compressed).digest('hex')),
    computePHash(compressed),
  ]);

  return {
    url,
    r2Key,
    mediaId,
    sha256,
    phash,
    mimeType: 'image/webp',
    originalMimeType: mimeType,
    width,
    height,
    isPrimary: false,
    submittedBy: opts.submittedBy || undefined,
    receivedAt: opts.receivedAt || new Date(),
  };
}

module.exports = { processMedia, deleteFromR2, computePHash, compressImage, uploadToR2 };
