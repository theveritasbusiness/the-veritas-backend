#!/usr/bin/env node
// Phase 0 — enumerate every asset in the Cloudinary account.
// This manifest is the thing that becomes impossible to obtain after billing lapses.
// Read-only. Writes out/manifest.json + out/manifest.csv.
import fs from "node:fs";
import path from "node:path";
import { need, OUT, bytes, retry } from "./lib/env.mjs";

const cfg = need("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET");
const AUTH = "Basic " +
  Buffer.from(`${cfg.CLOUDINARY_API_KEY}:${cfg.CLOUDINARY_API_SECRET}`).toString("base64");
const API = `https://api.cloudinary.com/v1_1/${cfg.CLOUDINARY_CLOUD_NAME}`;

const RESOURCE_TYPES = ["image", "video", "raw"];
const DELIVERY_TYPES = ["upload", "private", "authenticated"];

async function page(resourceType, deliveryType, cursor) {
  const url = new URL(`${API}/resources/${resourceType}/${deliveryType}`);
  url.searchParams.set("max_results", "500");
  url.searchParams.set("tags", "true");
  url.searchParams.set("context", "true");
  if (cursor) url.searchParams.set("next_cursor", cursor);

  const res = await fetch(url, { headers: { Authorization: AUTH } });

  // A delivery type with nothing in it 404s. That is not an error.
  if (res.status === 404) return { resources: [], missing: true };
  if (res.status === 420 || res.status === 429) {
    throw new Error("Cloudinary rate limit hit (500 admin calls/hour) — wait and re-run; this script resumes.");
  }
  if (!res.ok) {
    throw new Error(`${resourceType}/${deliveryType} -> HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const all = [];
const perBucket = [];

for (const resourceType of RESOURCE_TYPES) {
  for (const deliveryType of DELIVERY_TYPES) {
    let cursor = null;
    let count = 0;
    let missing = false;

    do {
      const data = await retry(() => page(resourceType, deliveryType, cursor), {
        label: `${resourceType}/${deliveryType}`
      });
      if (data.missing) { missing = true; break; }

      for (const r of data.resources || []) {
        all.push({
          public_id: r.public_id,
          resource_type: r.resource_type,
          delivery_type: r.type,
          format: r.format,
          version: r.version,
          bytes: r.bytes,
          width: r.width ?? null,
          height: r.height ?? null,
          created_at: r.created_at,
          secure_url: r.secure_url,
          tags: r.tags || []
        });
        count += 1;
      }
      cursor = data.next_cursor || null;
      if (cursor) process.stdout.write(`\r  ${resourceType}/${deliveryType}: ${count} so far...`);
    } while (cursor);

    if (!missing && count > 0) {
      perBucket.push({ bucket: `${resourceType}/${deliveryType}`, count });
      process.stdout.write(`\r  ${resourceType}/${deliveryType}: ${count}\n`);
    }
  }
}

// A transformation segment in the URL means a re-encode, not the master.
const suspicious = all.filter((r) => /\/upload\/[a-z]{1,3}_[^/]+\//.test(r.secure_url));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(all, null, 2));
fs.writeFileSync(
  path.join(OUT, "manifest.csv"),
  ["public_id,resource_type,delivery_type,format,bytes,width,height,secure_url"]
    .concat(all.map((r) =>
      [r.public_id, r.resource_type, r.delivery_type, r.format, r.bytes, r.width, r.height, r.secure_url]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")))
    .join("\n")
);

const total = all.reduce((sum, r) => sum + (r.bytes || 0), 0);
console.log(`\n─────────────────────────────────────────`);
for (const b of perBucket) console.log(`  ${b.bucket.padEnd(24)} ${String(b.count).padStart(6)}`);
console.log(`─────────────────────────────────────────`);
console.log(`  TOTAL ASSETS             ${String(all.length).padStart(6)}`);
console.log(`  TOTAL BYTES              ${bytes(total).padStart(6)}`);
if (suspicious.length) {
  console.log(`\n  WARNING: ${suspicious.length} secure_urls carry a transformation segment.`);
  console.log(`  Those would archive as re-encodes, not masters. Listed in out/suspicious.json`);
  fs.writeFileSync(path.join(OUT, "suspicious.json"), JSON.stringify(suspicious, null, 2));
}
console.log(`\n  Wrote out/manifest.json  (${bytes(total)} to download)\n`);
