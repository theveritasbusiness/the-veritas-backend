import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// Cloudflare R2 speaks the S3 API. Everything vendor-specific is confined to this
// file, so moving to B2 or S3 later is an endpoint and a credential change.
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET || "veritas-media";

// Public base. Always a hostname we control, never the vendor's, so a future
// storage move is a DNS change instead of another database rewrite.
export const CDN_BASE = (process.env.CDN_BASE || "https://cdn.theveritas.in").replace(/\/$/, "");

export const mediaConfigured = Boolean(
  ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
);

const client = mediaConfigured
  ? new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  })
  : null;

// Keys are content-addressed, so a key never changes meaning and can cache forever.
const IMMUTABLE = "public, max-age=31536000, immutable";

export async function put(key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: IMMUTABLE
    })
  );
}

export async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err.name === "NotFound") {
      return false;
    }
    throw err;
  }
}

export function urlFor(key) {
  return `${CDN_BASE}/${key}`;
}
