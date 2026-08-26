#!/usr/bin/env node
// Independent integrity check: the download script's byte-count match proves we got
// the right NUMBER of bytes. This proves they are the RIGHT bytes — every image is
// decodable and its dimensions match what Cloudinary reported.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import sharp from "sharp";
import { OUT, ARCHIVE, bytes } from "./lib/env.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const problems = [];
const sums = {};
let images = 0, videos = 0, other = 0;

for (const r of manifest) {
  const file = path.join(ARCHIVE, r.resource_type, `${r.public_id}${r.format ? "." + r.format : ""}`);
  if (!fs.existsSync(file)) { problems.push({ id: r.public_id, why: "missing on disk" }); continue; }

  const buf = fs.readFileSync(file);
  if (buf.length !== r.bytes) { problems.push({ id: r.public_id, why: `size ${buf.length} != ${r.bytes}` }); continue; }
  sums[r.public_id] = crypto.createHash("sha256").update(buf).digest("hex");

  if (r.resource_type === "image" && r.format !== "svg") {
    try {
      const m = await sharp(buf).metadata();
      const swap = m.orientation >= 5;
      const w = swap ? m.height : m.width, h = swap ? m.width : m.height;
      if (r.width && r.height && (w !== r.width || h !== r.height)) {
        problems.push({ id: r.public_id, why: `dims ${w}x${h} != manifest ${r.width}x${r.height}` });
      } else images++;
    } catch (e) { problems.push({ id: r.public_id, why: `undecodable: ${e.message}` }); }
  } else if (r.resource_type === "video") {
    // mp4 must carry an 'ftyp' box in the first 32 bytes
    if (!buf.subarray(0, 32).includes(Buffer.from("ftyp"))) {
      problems.push({ id: r.public_id, why: "no mp4 ftyp box — truncated?" });
    } else videos++;
  } else other++;
}

fs.writeFileSync(path.join(OUT, "checksums.json"), JSON.stringify(sums, null, 2));
const total = manifest.reduce((s, r) => s + (r.bytes || 0), 0);
console.log(`\n  images decoded + dimensions verified   ${String(images).padStart(4)}`);
console.log(`  videos with valid container headers    ${String(videos).padStart(4)}`);
console.log(`  svg / other (size-verified only)       ${String(other).padStart(4)}`);
console.log(`  PROBLEMS                               ${String(problems.length).padStart(4)}`);
console.log(`\n  ${bytes(total)} archived, sha256 recorded for ${Object.keys(sums).length} files`);
if (problems.length) { console.log("\n" + problems.slice(0,20).map(p=>`  ! ${p.id}: ${p.why}`).join("\n")); process.exit(1); }
console.log(`\n  ARCHIVE VERIFIED — the Cloudinary deadline no longer applies.\n`);
