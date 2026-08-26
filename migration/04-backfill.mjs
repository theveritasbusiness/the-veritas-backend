#!/usr/bin/env node
// Phase 4 — generate derivatives from the local archive and upload to R2.
// Runs entirely offline from Cloudinary. Idempotent: content-addressed keys mean
// re-running skips work already done. Resumable via out/url-map.json.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import pLimit from "p-limit";
import sharp from "sharp";
import { probe, derivatives, hashOf } from "../src/media/pipeline.js";
import { put, exists } from "./lib/storage.mjs";
import { OUT, ARCHIVE, bytes } from "./lib/env.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const MAP_FILE = path.join(OUT, "url-map.json");
const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};

// Cloudinary's stock demo content ships with every account. Not ours, not referenced.
const isStock = (r) => r.public_id.startsWith("samples/") ||
  ["sample", "cld-sample", "cld-sample-video"].includes(r.public_id);

const work = manifest.filter((r) => !isStock(r));
const limit = pLimit(Number(process.env.BACKFILL_CONCURRENCY || 3));

let done = 0, skipped = 0, failed = 0, inBytes = 0, outBytes = 0, uploads = 0;
const failures = [];

function archivePath(r) {
  return path.join(ARCHIVE, r.resource_type, `${r.public_id}${r.format ? "." + r.format : ""}`);
}

async function handle(r) {
  if (map[r.secure_url]) { skipped += 1; return; }

  const buf = fs.readFileSync(archivePath(r));
  const hash = hashOf(buf);
  const ext = r.format || "bin";

  // Videos and vector/animated assets pass through untouched — no derivative set.
  const passthrough = r.resource_type === "video" || ext === "svg";
  let meta = null;
  if (!passthrough) {
    try { meta = await probe(buf); }
    catch { /* unprobeable -> treat as passthrough */ }
  }
  const animated = meta?.animated === true;

  const originalKey = r.resource_type === "video"
    ? `video/${hash}.${ext}`
    : `originals/${hash}.${ext}`;

  if (!(await exists(originalKey))) {
    await put(originalKey, buf, mimeFor(ext), { immutable: true });
    uploads += 1;
  }

  let canonical, base = null;

  if (passthrough || !meta || animated) {
    // Serve the original directly: video, svg, animated gif.
    canonical = originalKey;
  } else {
    const set = await derivatives(buf, hash, meta);
    for (const d of set) {
      if (!(await exists(d.key))) { await put(d.key, d.body, d.contentType); uploads += 1; }
      outBytes += d.body.length;
    }
    base = `img/${hash}`;
    // The <img> fallback and og:image target. JPEG, because social crawlers
    // (WhatsApp, X, Facebook) do not decode AVIF.
    const jpg = set.find((d) => d.key.endsWith(".jpg"));
    canonical = jpg ? jpg.key : set[0].key;
  }

  inBytes += buf.length;
  map[r.secure_url] = {
    public_id: r.public_id,
    kind: r.resource_type,
    hash,
    original: originalKey,
    base,
    canonical,
    width: meta?.width ?? r.width ?? null,
    height: meta?.height ?? r.height ?? null,
    bytes_before: buf.length
  };
  done += 1;

  if ((done + skipped) % 20 === 0) {
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
    process.stdout.write(`\r  ${done + skipped}/${work.length}  ${uploads} objects uploaded  (${bytes(inBytes)} in -> ${bytes(outBytes)} out)   `);
  }
}

function mimeFor(ext) {
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    avif: "image/avif", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4" }[ext] || "application/octet-stream";
}

console.log(`\nBackfilling ${work.length} assets (${manifest.length - work.length} Cloudinary stock assets skipped)\n`);

await Promise.all(work.map((r) => limit(async () => {
  try { await handle(r); }
  catch (error) { failed += 1; failures.push({ public_id: r.public_id, error: error.message }); }
})));

fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
if (failures.length) fs.writeFileSync(path.join(OUT, "backfill-failures.json"), JSON.stringify(failures, null, 2));

console.log(`\n\n─────────────────────────────────────────`);
console.log(`  processed         ${String(done).padStart(6)}`);
console.log(`  already mapped    ${String(skipped).padStart(6)}`);
console.log(`  FAILED            ${String(failed).padStart(6)}`);
console.log(`  objects uploaded  ${String(uploads).padStart(6)}`);
console.log(`─────────────────────────────────────────`);
console.log(`  source bytes      ${bytes(inBytes)}`);
console.log(`  derivative bytes  ${bytes(outBytes)}`);
if (inBytes) console.log(`  reduction         ${Math.round((1 - outBytes / inBytes) * 100)}%`);
console.log(`\n  url-map.json has ${Object.keys(map).length} entries\n`);
process.exit(failed > 0 ? 1 : 0);
