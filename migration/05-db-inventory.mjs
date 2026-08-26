#!/usr/bin/env node
// Read-only. Finds every Cloudinary URL the database references, across all four
// columns that can hold one, and reconciles them against what we migrated.
import fs from "node:fs"; import path from "node:path";
import pg from "pg";
import { need, OUT } from "./lib/env.mjs";

const { DATABASE_PUBLIC_URL } = need("DATABASE_PUBLIC_URL");
const pool = new pg.Pool({ connectionString: DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });

const COLUMNS = ["hero_image", "content_blocks", "content", "live_updates"];
const URL_RE = /https?:\/\/res\.cloudinary\.com\/[^\s"'\\<>)\]]+/g;

// .../<cloud>/<resource_type>/<delivery>/[transforms/]?[v123/]?<public_id>.<ext>
export function publicIdOf(url) {
  const m = url.match(/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/(upload|private|authenticated)\/(.+)$/);
  if (!m) return null;
  let rest = m[3].split("?")[0];
  const parts = rest.split("/");
  // drop leading transformation segments (contain "_" before any "," or "/") and the version
  while (parts.length > 1 && /^[a-z]{1,3}_[^/]*$/.test(parts[0].split(",")[0])) parts.shift();
  if (/^v\d+$/.test(parts[0])) parts.shift();
  rest = parts.join("/");
  return { resource_type: m[1], public_id: rest.replace(/\.[a-z0-9]+$/i, "") };
}

const cols = (await pool.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='articles'`)).rows.map(r => r.column_name);
const present = COLUMNS.filter(c => cols.includes(c));

const { rows: [{ count: articleCount }] } = await pool.query("SELECT count(*)::int AS count FROM articles");

const hits = [];
for (const col of present) {
  const { rows } = await pool.query(
    `SELECT id, ${col}::text AS val FROM articles WHERE ${col}::text LIKE '%cloudinary.com%'`);
  for (const row of rows) {
    for (const url of row.val.match(URL_RE) || []) hits.push({ id: row.id, col, url });
  }
}

// paragraphs is TEXT[]; check separately
if (cols.includes("paragraphs")) {
  const { rows } = await pool.query(
    `SELECT id, array_to_string(paragraphs, ' ') AS val FROM articles
     WHERE array_to_string(paragraphs,' ') LIKE '%cloudinary.com%'`);
  for (const row of rows) for (const url of row.val.match(URL_RE) || []) hits.push({ id: row.id, col: "paragraphs", url });
}

const urls = [...new Set(hits.map(h => h.url))];
const map = fs.existsSync(path.join(OUT, "url-map.json"))
  ? JSON.parse(fs.readFileSync(path.join(OUT, "url-map.json"), "utf8")) : {};
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const byPid = new Map(manifest.map(r => [`${r.resource_type}:${r.public_id}`, r]));

const exact = [], viaPid = [], orphan = [];
for (const url of urls) {
  if (map[url]) { exact.push(url); continue; }
  const p = publicIdOf(url);
  if (p && byPid.has(`${p.resource_type}:${p.public_id}`)) viaPid.push(url);
  else orphan.push(url);
}

const perCol = present.concat("paragraphs").map(c =>
  [c, hits.filter(h => h.col === c).length, new Set(hits.filter(h=>h.col===c).map(h=>h.id)).size]);

console.log(`\n  articles in table                 ${String(articleCount).padStart(6)}`);
console.log(`  articles referencing cloudinary   ${String(new Set(hits.map(h=>h.id)).size).padStart(6)}`);
console.log(`\n  BY COLUMN                    refs   articles`);
for (const [c, n, a] of perCol) console.log(`    ${c.padEnd(18)} ${String(n).padStart(6)} ${String(a).padStart(10)}`);
console.log(`\n  distinct cloudinary URLs          ${String(urls.length).padStart(6)}`);
console.log(`    exact match in url-map          ${String(exact.length).padStart(6)}`);
console.log(`    match by public_id              ${String(viaPid.length).padStart(6)}   (backfill still running, or transformed URL)`);
console.log(`    NO MATCH (orphan)               ${String(orphan.length).padStart(6)}`);

fs.writeFileSync(path.join(OUT, "db-urls.json"), JSON.stringify({ hits, urls, orphan }, null, 2));
if (orphan.length) {
  console.log(`\n  Orphans — referenced by the DB but absent from Cloudinary:`);
  orphan.slice(0, 12).forEach(u => console.log(`    ${u.slice(0, 100)}`));
  if (orphan.length > 12) console.log(`    ...and ${orphan.length - 12} more (see out/db-urls.json)`);
}
console.log("");
await pool.end();
