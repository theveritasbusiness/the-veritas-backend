#!/usr/bin/env node
// No credentials needed. Runs the real pipeline over local images and reports
// actual before/after bytes, so the format choices can be judged on evidence.
import fs from "node:fs";
import path from "node:path";
import { probe, derivatives, hashOf, SOCIAL_WIDTH } from "../src/media/pipeline.js";
import { bytes } from "./lib/env.mjs";

const dir = process.argv[2];
if (!dir) { console.error("usage: node dry-run-pipeline.mjs <dir>"); process.exit(1); }

const files = fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png|webp|avif|tiff?)$/i.test(f))
  .map((f) => path.join(dir, f));

let totalIn = 0, totalOut = 0, totalHero = 0;
const rows = [];

for (const file of files) {
  const buf = fs.readFileSync(file);
  let meta;
  try { meta = await probe(buf); } catch { continue; }

  const started = process.hrtime.bigint();
  const out = await derivatives(buf, hashOf(buf), meta);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const setBytes = out.reduce((s, d) => s + d.body.length, 0);
  // What a reader on a phone-sized viewport actually downloads today vs after.
  const heroAvif = out.find((d) => d.key.endsWith("/1200.avif"))
    || out.find((d) => d.key.endsWith(".avif"));

  totalIn += buf.length;
  totalOut += setBytes;
  totalHero += heroAvif ? heroAvif.body.length : 0;

  rows.push({
    name: path.basename(file),
    dims: `${meta.width}x${meta.height}`,
    before: buf.length,
    hero: heroAvif ? heroAvif.body.length : 0,
    variants: out.length,
    set: setBytes,
    ms: Math.round(ms)
  });
}

rows.sort((a, b) => b.before - a.before);

const w = [26, 11, 10, 10, 7, 10, 7];
const head = ["FILE", "DIMENSIONS", "BEFORE", "AVIF 1200", "SAVED", "FULL SET", "ENCODE"];
console.log("\n" + head.map((h, i) => h.padEnd(w[i])).join(""));
console.log("─".repeat(w.reduce((a, b) => a + b, 0)));
for (const r of rows) {
  const saved = r.hero ? `${Math.round((1 - r.hero / r.before) * 100)}%` : "—";
  console.log([
    r.name.slice(0, 25).padEnd(w[0]),
    r.dims.padEnd(w[1]),
    bytes(r.before).padEnd(w[2]),
    bytes(r.hero).padEnd(w[3]),
    saved.padEnd(w[4]),
    `${bytes(r.set)}/${r.variants}`.padEnd(w[5]),
    `${r.ms}ms`.padEnd(w[6])
  ].join(""));
}
console.log("─".repeat(w.reduce((a, b) => a + b, 0)));
console.log(`\n  ${rows.length} images`);
console.log(`  Served today (originals)      ${bytes(totalIn)}`);
console.log(`  Served after (AVIF @${SOCIAL_WIDTH})     ${bytes(totalHero)}   <- what readers download`);
console.log(`  Reduction on the wire         ${Math.round((1 - totalHero / totalIn) * 100)}%`);
console.log(`  Full derivative set stored    ${bytes(totalOut)}   <- what B2 bills for`);
console.log(`  Storage change                ${totalOut > totalIn ? "+" : ""}${Math.round((totalOut / totalIn - 1) * 100)}%\n`);
