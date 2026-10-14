/**
 * Cloudflare R2 helper — production storage.
 *
 * R2 is S3-compatible, so we use @aws-sdk/client-s3 pointed at the R2 endpoint.
 *
 * Env vars required (see .env.example):
 *   R2_ACCOUNT_ID       — Cloudflare account id (part of endpoint URL)
 *   R2_ACCESS_KEY_ID    — from R2 Manage API Tokens
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET           — bucket name, e.g. 'trip-assets'
 *   R2_PUBLIC_BASE_URL  — public URL prefix for objects, e.g.
 *                          https://pub-<hash>.r2.dev  (r2.dev subdomain — dev only)
 *                          https://cdn.example.com    (custom domain — production)
 *
 * Usage:
 *   const { uploadObject, deleteObject, publicUrl } = require('./r2');
 *   await uploadObject('themes/dragon_ball/v3/bundle.zip', buffer, 'application/zip');
 *   const url = publicUrl('themes/dragon_ball/v3/bundle.zip');
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

function assertConfigured() {
  const missing = [];
  if (!ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
  if (!ACCESS_KEY) missing.push('R2_ACCESS_KEY_ID');
  if (!SECRET_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!BUCKET) missing.push('R2_BUCKET');
  if (missing.length) {
    throw new Error(`R2 not configured. Missing env: ${missing.join(', ')}. See .env.example.`);
  }
}

let _client;
function client() {
  if (_client) return _client;
  assertConfigured();
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return _client;
}

async function uploadObject(key, body, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

async function deleteObject(key) {
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    // Idempotent: 404 = already gone = success.
    if (err.$metadata?.httpStatusCode !== 404 && err.Code !== 'NoSuchKey') throw err;
  }
}

async function headObject(key) {
  try {
    const res = await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: res.ContentLength, contentType: res.ContentType, lastModified: res.LastModified };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function listObjects(prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const res = await client().send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken,
    }));
    (res.Contents || []).forEach((o) => out.push({
      key: o.Key, size: o.Size, lastModified: o.LastModified,
    }));
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

function publicUrl(key) {
  if (!PUBLIC_BASE_URL) {
    throw new Error('R2_PUBLIC_BASE_URL not set — cannot build public URL. See .env.example.');
  }
  return `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
}

/** Delete old bundle versions per retention policy (keep last N). */
async function purgeOldVersions(themeId, currentVersion, keep = 3, prefix = 'themes') {
  const cutoff = currentVersion - keep;
  const jobs = [];
  for (let v = 1; v <= cutoff; v++) {
    const base = `${prefix}/${themeId}/v${v}`;
    jobs.push(
      deleteObject(`${base}/bundle.zip`),
      deleteObject(`${base}/preview.webp`),
      deleteObject(`${base}/preview.png`),
      deleteObject(`${base}/preview.jpg`),
    );
  }
  await Promise.allSettled(jobs);
}

module.exports = {
  uploadObject,
  deleteObject,
  headObject,
  listObjects,
  publicUrl,
  purgeOldVersions,
  BUCKET,
};
