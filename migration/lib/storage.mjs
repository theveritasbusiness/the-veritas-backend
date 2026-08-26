// R2 is S3-compatible, so this is a thin wrapper. Swapping to B2 or S3 later means
// changing the endpoint and credentials here and nothing else.
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command }
  from "@aws-sdk/client-s3";
import { need, retry } from "./env.mjs";

const cfg = need("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET");

export const BUCKET = cfg.R2_BUCKET;
export const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");

export const s3 = new S3Client({
  region: "auto",                                   // R2 ignores region; "auto" is required
  endpoint: `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: cfg.R2_ACCESS_KEY_ID,
    secretAccessKey: cfg.R2_SECRET_ACCESS_KEY
  }
});

// Derivatives are content-addressed, so a key never changes meaning. Cache forever.
const IMMUTABLE = "public, max-age=31536000, immutable";

export async function put(key, body, contentType, { immutable = true } = {}) {
  return retry(() => s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: immutable ? IMMUTABLE : "public, max-age=300"
  })), { label: `put ${key}` });
}

export async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error.name === "NotFound") return false;
    throw error;
  }
}

export async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const res = await retry(() => s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000
    })), { label: `list ${prefix}` });
    for (const o of res.Contents || []) keys.push({ key: o.Key, size: o.Size });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export function urlFor(key) {
  return `${CDN_BASE}/${key}`;
}
