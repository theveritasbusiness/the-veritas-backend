#!/usr/bin/env node
// Phase 1 — download every original to local disk, byte-verified against the manifest.
// Resumable: re-running skips files already on disk at the correct size.
// This is the step that neutralises the billing deadline.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pLimit from "p-limit";
import { OUT, ARCHIVE, bytes, retry } from "./lib/env.mjs";

const manifestPath = path.join(OUT, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("out/manifest.json not found — run 01-cloudinary-inventory.mjs first.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 8);
const limit = pLimit(CONCURRENCY);

// public_id may contain slashes; mirror them as directories.
function destFor(r) {
  const ext = r.format ? `.${r.format}` : "";
  return path.join(ARCHIVE, r.resource_type, `${r.public_id}${ext}`);
}

const ledger = [];
let done = 0, skipped = 0, failed = 0, downloadedBytes = 0;
const failures = [];

async function fetchOne(r) {
  const dest = destFor(r);

  if (fs.existsSync(dest) && fs.statSync(dest).size === r.bytes) {
    skipped += 1;
    ledger.push({ ...r, dest, status: "already-present", sha256: null });
    return;
  }

  await retry(async () => {
    const res = await fetch(r.secure_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // The manifest's byte count is the proof we got the master, not a re-encode.
    if (typeof r.bytes === "number" && buf.length !== r.bytes) {
      throw new Error(`size mismatch: expected ${r.bytes}, got ${buf.length}`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    downloadedBytes += buf.length;
    ledger.push({
      ...r,
      dest,
      status: "downloaded",
      sha256: crypto.createHash("sha256").update(buf).digest("hex")
    });
  }, { label: r.public_id });

  done += 1;
  if ((done + skipped) % 25 === 0) {
    process.stdout.write(`\r  ${done + skipped}/${manifest.length}  (${bytes(downloadedBytes)} fetched)`);
  }
}

console.log(`Downloading ${manifest.length} assets -> ${ARCHIVE}  [concurrency ${CONCURRENCY}]\n`);

await Promise.all(manifest.map((r) => limit(async () => {
  try {
    await fetchOne(r);
  } catch (error) {
    failed += 1;
    failures.push({ public_id: r.public_id, secure_url: r.secure_url, error: error.message });
  }
})));

fs.writeFileSync(path.join(OUT, "archive-ledger.json"), JSON.stringify(ledger, null, 2));
if (failures.length) {
  fs.writeFileSync(path.join(OUT, "download-failures.json"), JSON.stringify(failures, null, 2));
}

const expected = manifest.reduce((sum, r) => sum + (r.bytes || 0), 0);
const onDisk = ledger.reduce((sum, r) => sum + (r.bytes || 0), 0);

console.log(`\n\n─────────────────────────────────────────`);
console.log(`  downloaded        ${String(done).padStart(6)}`);
console.log(`  already present   ${String(skipped).padStart(6)}`);
console.log(`  FAILED            ${String(failed).padStart(6)}`);
console.log(`─────────────────────────────────────────`);
console.log(`  manifest bytes    ${bytes(expected)}`);
console.log(`  archived bytes    ${bytes(onDisk)}`);
console.log(`  match             ${expected === onDisk ? "YES — archive is complete" : "NO — investigate before proceeding"}`);
if (failures.length) console.log(`\n  See out/download-failures.json — re-run to retry only those.`);
console.log("");
process.exit(failed > 0 || expected !== onDisk ? 1 : 0);
