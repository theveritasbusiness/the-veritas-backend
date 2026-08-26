#!/usr/bin/env node
// Imports the backfill's url-map into media_assets, which is what the read-time
// rewrite middleware reads. Idempotent: re-running updates rather than duplicates.
import fs from "node:fs"; import path from "node:path";
import pg from "pg";
import { need, OUT } from "./lib/env.mjs";

const { DATABASE_PUBLIC_URL } = need("DATABASE_PUBLIC_URL");
const pool = new pg.Pool({ connectionString: DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });

const map = JSON.parse(fs.readFileSync(path.join(OUT, "url-map.json"), "utf8"));

await pool.query(`
  CREATE TABLE IF NOT EXISTS media_assets (
    id SERIAL PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'image',
    base_path TEXT,
    canonical_key TEXT NOT NULL,
    original_key TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes_before BIGINT,
    bytes_after BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
// One image can have many Cloudinary URLs (90 assets were uploaded more than
// once, one of them six times), so the mapping is a separate table.
await pool.query(`
  CREATE TABLE IF NOT EXISTS media_url_map (
    cloudinary_url TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL REFERENCES media_assets (sha256) ON DELETE CASCADE
  )`);
await pool.query(`CREATE INDEX IF NOT EXISTS media_url_map_sha_idx ON media_url_map (sha256)`);

// Clean up the earlier, incorrect one-URL-per-asset column if it is still there.
await pool.query(`ALTER TABLE media_assets DROP COLUMN IF EXISTS cloudinary_url`);

const entries = Object.entries(map);

// Batched rather than row-at-a-time: over the Railway proxy each round trip is
// ~200ms, so 807 entries one at a time is ~5 minutes of pure latency.
const CHUNK = 200;
let assets = 0, links = 0;

for (let i = 0; i < entries.length; i += CHUNK) {
  const chunk = entries.slice(i, i + CHUNK);

  const assetValues = [];
  const assetParams = [];
  const seen = new Set();

  for (const [, e] of chunk) {
    if (seen.has(e.hash)) continue;   // a chunk can hold duplicates of one image
    seen.add(e.hash);
    const n = assetParams.length;
    assetValues.push(`($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7},$${n+8})`);
    assetParams.push(e.hash, e.kind, e.base, e.canonical, e.original, e.width, e.height, e.bytes_before);
  }

  await pool.query(
    `INSERT INTO media_assets
       (sha256, kind, base_path, canonical_key, original_key, width, height, bytes_before)
     VALUES ${assetValues.join(",")}
     ON CONFLICT (sha256) DO UPDATE SET
       base_path = EXCLUDED.base_path, canonical_key = EXCLUDED.canonical_key`,
    assetParams
  );
  assets += seen.size;

  const linkValues = [];
  const linkParams = [];

  for (const [url, e] of chunk) {
    const n = linkParams.length;
    linkValues.push(`($${n+1},$${n+2})`);
    linkParams.push(url, e.hash);
  }

  await pool.query(
    `INSERT INTO media_url_map (cloudinary_url, sha256) VALUES ${linkValues.join(",")}
     ON CONFLICT (cloudinary_url) DO UPDATE SET sha256 = EXCLUDED.sha256`,
    linkParams
  );
  links += chunk.length;
}

const { rows: [stats] } = await pool.query(
  `SELECT (SELECT count(*)::int FROM media_assets) AS assets,
          (SELECT count(*)::int FROM media_url_map) AS links,
          (SELECT count(*)::int FROM media_assets WHERE kind='video') AS videos`);

console.log(`\n  processed ${assets} map entries -> ${links} url links`);
console.log(`  media_assets  ${stats.assets} distinct images (${stats.videos} video)`);
console.log(`  media_url_map ${stats.links} Cloudinary URLs mapped\n`);
await pool.end();
