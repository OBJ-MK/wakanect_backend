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

// ─── R2 upload / delete ───────────────────────────────────────────────────────

async function uploadToR2(buffer, { merchantId, parsedMessageId }) {
  const folder = parsedMessageId
    ? `merchants/${merchantId}/products/${parsedMessageId}`
    : `merchants/${merchantId}/pending`;

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
  const { url, r2Key } = await uploadToR2(compressed, {
    merchantId: opts.merchantId,
    parsedMessageId: opts.parsedMessageId,
  });

  return {
    url,
    r2Key,
    mediaId,
    mimeType: 'image/webp',
    originalMimeType: mimeType,
    width,
    height,
    isPrimary: false,
    submittedBy: opts.submittedBy || undefined,
    receivedAt: opts.receivedAt || new Date(),
  };
}

module.exports = { processMedia, deleteFromR2 };
