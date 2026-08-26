import pool from "../db.js";

// Read-time Cloudinary -> CDN rewriting.
//
// This exists so the cutover is reversible. With MEDIA_REWRITE=on the API serves
// R2 URLs while the database still holds Cloudinary ones; with it off, everything
// reverts on a restart. Only once this has run quietly for a while do we rewrite
// the rows themselves, and then this middleware can be deleted.
const URL_RE = /https?:\/\/res\.cloudinary\.com\/[^\s"'\\<>)\]]+/g;

let byUrl = new Map();
let byPublicId = new Map();
let loaded = false;

export function rewriteEnabled() {
  return process.env.MEDIA_REWRITE === "on";
}

// .../<cloud>/<resource_type>/<delivery>/[transforms/][v123/]<public_id>.<ext>
export function publicIdOf(url) {
  const match = url.match(
    /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/(?:upload|private|authenticated)\/(.+)$/
  );

  if (!match) return null;

  const parts = match[2].split("?")[0].split("/");

  while (parts.length > 1 && /^[a-z]{1,3}_[^/]*$/.test(parts[0].split(",")[0])) {
    parts.shift();
  }

  if (/^v\d+$/.test(parts[0])) {
    parts.shift();
  }

  return `${match[1]}:${parts.join("/").replace(/\.[a-z0-9]+$/i, "")}`;
}

export async function loadMediaMap() {
  const { rows } = await pool.query(`
    SELECT m.cloudinary_url, a.canonical_key
    FROM media_url_map m
    JOIN media_assets a ON a.sha256 = m.sha256
  `);

  const base = (process.env.CDN_BASE || "https://cdn.theveritas.in").replace(/\/$/, "");
  const nextByUrl = new Map();
  const nextByPublicId = new Map();

  for (const row of rows) {
    const url = `${base}/${row.canonical_key}`;
    nextByUrl.set(row.cloudinary_url, url);

    const pid = publicIdOf(row.cloudinary_url);
    if (pid) nextByPublicId.set(pid, url);
  }

  byUrl = nextByUrl;
  byPublicId = nextByPublicId;
  loaded = true;

  return rows.length;
}

export function rewriteString(value) {
  if (typeof value !== "string" || !value.includes("cloudinary.com")) {
    return value;
  }

  return value.replace(URL_RE, (url) => {
    const direct = byUrl.get(url);
    if (direct) return direct;

    const pid = publicIdOf(url);
    // Unmapped URLs pass through untouched rather than breaking the page.
    return (pid && byPublicId.get(pid)) || url;
  });
}

function rewriteDeep(value) {
  if (typeof value === "string") return rewriteString(value);
  if (Array.isArray(value)) return value.map(rewriteDeep);

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = rewriteDeep(inner);
    return out;
  }

  return value;
}

// Wraps res.json once, globally, so no route can be missed and no business
// logic has to know this is happening.
export function mediaRewriteMiddleware(req, res, next) {
  if (!rewriteEnabled()) return next();

  const original = res.json.bind(res);

  res.json = (body) => {
    try {
      if (!loaded) return original(body);
      return original(rewriteDeep(body));
    } catch (err) {
      console.error("MEDIA REWRITE ERROR:", err);
      return original(body);
    }
  };

  next();
}
