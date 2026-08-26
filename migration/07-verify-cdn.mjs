#!/usr/bin/env node
// Pre-cutover gate: every canonical URL the database will point at must return
// 200 with a sane content-type and non-zero length. A 200 on a truncated upload
// is the failure this is written to catch, so it checks bytes, not just status.
import fs from "node:fs"; import path from "node:path";
import pLimit from "p-limit";
import { OUT, bytes } from "./lib/env.mjs";

const map = JSON.parse(fs.readFileSync(path.join(OUT, "url-map.json"), "utf8"));
const base = (process.env.CDN_BASE || "https://cdn.theveritas.in").replace(/\/$/, "");

// One canonical URL per distinct image; that is what lands in the DB.
const targets = [...new Map(Object.values(map).map((e) => [e.hash, e])).values()];
const limit = pLimit(12);

let ok = 0, served = 0;
const bad = [];

await Promise.all(targets.map((e) => limit(async () => {
  const url = `${base}/${e.canonical}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") || "";

    if (!res.ok) return bad.push({ url, why: `HTTP ${res.status}` });
    if (buf.length === 0) return bad.push({ url, why: "zero bytes" });
    if (!/^(image|video)\//.test(type)) return bad.push({ url, why: `content-type ${type}` });
    if (!/immutable/.test(res.headers.get("cache-control") || "")) {
      return bad.push({ url, why: "cache-control not immutable" });
    }

    ok += 1;
    served += buf.length;
  } catch (err) {
    bad.push({ url, why: err.message });
  }
})));

console.log(`\n  canonical URLs checked   ${targets.length}`);
console.log(`  served correctly         ${ok}`);
console.log(`  FAILED                   ${bad.length}`);
console.log(`  total bytes served       ${bytes(served)}  (avg ${bytes(served / Math.max(ok, 1))})`);

if (bad.length) {
  console.log("");
  bad.slice(0, 15).forEach((b) => console.log(`  ! ${b.why.padEnd(28)} ${b.url}`));
  process.exit(1);
}
console.log(`\n  ALL CANONICAL URLS LIVE — safe to cut over\n`);
