#!/usr/bin/env node
// Smoke test before the real backfill: prove credentials, bucket, write path,
// and the public custom domain all work end to end with one tiny object.
import sharp from "sharp";
import { put, exists, listAll, urlFor, BUCKET, CDN_BASE } from "./lib/storage.mjs";
import { bytes } from "./lib/env.mjs";

const key = "_healthcheck/probe.avif";
const probe = await sharp({
  create: { width: 32, height: 32, channels: 3, background: "#14636B" }
}).avif({ quality: 50, effort: 2 }).toBuffer();

console.log(`\n  bucket        ${BUCKET}`);
console.log(`  cdn base      ${CDN_BASE || "(CDN_BASE not set)"}`);

process.stdout.write(`  write         `);
await put(key, probe, "image/avif");
console.log(`ok (${bytes(probe.length)})`);

process.stdout.write(`  read back     `);
console.log(await exists(key) ? "ok" : "FAILED — object not found after write");

process.stdout.write(`  list          `);
const existing = await listAll("");
console.log(`ok (${existing.length} object${existing.length === 1 ? "" : "s"} in bucket)`);

if (CDN_BASE) {
  process.stdout.write(`  public fetch  `);
  try {
    const res = await fetch(urlFor(key), { cache: "no-store" });
    if (res.ok) {
      const cc = res.headers.get("cache-control") || "(none)";
      const cf = res.headers.get("cf-cache-status") || "(none)";
      console.log(`ok — HTTP ${res.status}`);
      console.log(`  cache-control ${cc}`);
      console.log(`  cf-cache      ${cf}`);
      if (!/immutable/.test(cc)) console.log(`  ! expected an immutable Cache-Control — check the R2 custom domain is serving object metadata`);
    } else {
      console.log(`HTTP ${res.status} — custom domain not live yet, or still Initializing`);
    }
  } catch (error) {
    console.log(`unreachable — ${error.message}`);
    console.log(`  (DNS for the custom domain may still be propagating; retry in a minute)`);
  }
}
console.log("");
