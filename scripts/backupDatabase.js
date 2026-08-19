'use strict';

/**
 * Backup manuel de la base MongoDB Atlas vers Cloudflare R2.
 *
 * Pourquoi ce script existe : le cluster Atlas est en tier M0 (gratuit),
 * qui n'offre AUCUN backup automatique natif. Ce script exporte chaque
 * collection en JSON (via bson/EJSON pour préserver ObjectId/Date/etc.),
 * compresse en gzip, et uploade vers le bucket R2 déjà utilisé pour les
 * médias — donc aucun nouveau service, aucun nouveau coût.
 *
 * Déclenchement : voir .github/workflows/backup-db.yml (cron GitHub Actions,
 * gratuit, et indépendant du sommeil du backend Render free tier — un
 * cron interne au process ne se déclencherait pas fiablement si le
 * service dort).
 *
 * Usage manuel : node scripts/backupDatabase.js
 * Variables requises : MONGODB_URI, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *                       R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

require('dotenv').config();
const zlib = require('zlib');
const { promisify } = require('util');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const gzip = promisify(zlib.gzip);

// Rétention : on garde 30 jours de backups sur R2, le reste est purgé
// automatiquement à chaque run pour ne pas faire gonfler le stockage.
const RETENTION_DAYS = 30;
const BACKUP_PREFIX = 'backups/wakanect/';

// Toutes les collections applicatives — à tenir à jour si un modèle est ajouté.
const COLLECTIONS = [
  'merchants',
  'products',
  'orders',
  'subscriptions',
  'payments',
  'parsedmessages',
  'parsingevents',
  'pendingmedias',
  'planconfigs',
  'pushsubscriptions',
  'notifications',
  'auditlogs',
  'counters',
];

function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function backupCollection(db, s3, collectionName, runFolder) {
  const docs = await db.collection(collectionName).find({}).toArray();
  const json = EJSON.stringify(docs, { relaxed: false });
  const compressed = await gzip(Buffer.from(json, 'utf8'));

  const key = `${runFolder}${collectionName}.json.gz`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: compressed,
    ContentType: 'application/gzip',
  }));

  return { collection: collectionName, docCount: docs.length, bytes: compressed.length };
}

async function purgeOldBackups(s3) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let continuationToken;
  let deleted = 0;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: continuationToken,
    }));

    for (const obj of list.Contents || []) {
      if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: obj.Key }));
        deleted += 1;
      }
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

async function main() {
  const required = ['MONGODB_URI', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(` Variables manquantes : ${missing.join(', ')}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runFolder = `${BACKUP_PREFIX}${timestamp}/`;

  console.log(` Connexion à MongoDB Atlas...`);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const db = mongoose.connection.db;
  const s3 = r2Client();

  console.log(` Export vers R2 : ${runFolder}`);
  const results = [];
  for (const name of COLLECTIONS) {
    try {
      const result = await backupCollection(db, s3, name, runFolder);
      results.push(result);
      console.log(`  ✅ ${name} : ${result.docCount} docs (${(result.bytes / 1024).toFixed(1)} Ko compressés)`);
    } catch (err) {
      console.error(`  ❌ ${name} : ${err.message}`);
      results.push({ collection: name, error: err.message });
    }
  }

  // Manifest récapitulatif du run, utile pour un audit ou une restauration ciblée
  const manifest = { timestamp, collections: results };
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: `${runFolder}manifest.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));

  console.log(` Purge des backups de plus de ${RETENTION_DAYS} jours...`);
  const deleted = await purgeOldBackups(s3);
  console.log(`  🗑️  ${deleted} fichier(s) supprimé(s)`);

  await mongoose.disconnect();

  const hasErrors = results.some((r) => r.error);
  if (hasErrors) {
    console.error(' Backup terminé avec des erreurs sur certaines collections.');
    process.exit(1);
  }
  console.log(' Backup terminé avec succès.');
}

main().catch((err) => {
  console.error(' Backup échoué:', err);
  process.exit(1);
});