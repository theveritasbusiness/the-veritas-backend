import express from "express";
import multer from "multer";
import pool from "../db.js";
import { requireAuth } from "../auth.js";
import { probe, derivatives, hashOf } from "../media/pipeline.js";
import { put, urlFor, mediaConfigured } from "../media/storage.js";

const router = express.Router();
let ensured = false;

const MAX_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

const VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const VIDEO_EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

async function ensureMediaTable() {
  if (ensured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id SERIAL PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'image',
      base_path TEXT,
      canonical_key TEXT NOT NULL,
      original_key TEXT NOT NULL,
      cloudinary_url TEXT UNIQUE,
      width INTEGER,
      height INTEGER,
      bytes_before BIGINT,
      bytes_after BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS media_assets_cloudinary_idx ON media_assets (cloudinary_url)`);

  ensured = true;
}

function payload(row) {
  return {
    url: urlFor(row.canonical_key),
    base: row.base_path ? urlFor(row.base_path) : null,
    width: row.width,
    height: row.height,
    kind: row.kind,
    // Cloudinary's response shape, so the CMS needs the smallest possible diff.
    secure_url: urlFor(row.canonical_key)
  };
}

// mp4/mov carry an 'ftyp' box near the start; webm starts with an EBML header.
function looksLikeVideo(buf) {
  return buf.subarray(0, 32).includes(Buffer.from("ftyp")) ||
    (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3);
}

router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!mediaConfigured) {
      return res.status(503).json({ error: "Media storage is not configured" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    await ensureMediaTable();

    const buf = req.file.buffer;
    const hash = hashOf(buf);

    // Same bytes uploaded twice costs nothing and returns the same URL.
    const existing = await pool.query("SELECT * FROM media_assets WHERE sha256 = $1", [hash]);

    if (existing.rows.length > 0) {
      return res.json(payload(existing.rows[0]));
    }

    const wantsVideo = String(req.body?.kind || req.query?.kind || "").toLowerCase() === "video";

    if (wantsVideo || looksLikeVideo(buf)) {
      if (!VIDEO_MIME.has(req.file.mimetype)) {
        return res.status(415).json({ error: `Unsupported video type: ${req.file.mimetype}` });
      }

      const ext = VIDEO_EXT[req.file.mimetype];
      const key = `video/${hash}.${ext}`;
      await put(key, buf, req.file.mimetype);

      const inserted = await pool.query(
        `INSERT INTO media_assets (sha256, kind, canonical_key, original_key, bytes_before, bytes_after)
         VALUES ($1, 'video', $2, $2, $3, $3) RETURNING *`,
        [hash, key, buf.length]
      );

      return res.json(payload(inserted.rows[0]));
    }

    // Magic-byte sniff via sharp. The client's Content-Type is not trusted.
    const meta = await probe(buf);

    const originalKey = `originals/${hash}.${meta.format === "jpeg" ? "jpg" : meta.format}`;
    const originalUpload = put(originalKey, buf, req.file.mimetype || "application/octet-stream");

    // Animated sources (GIF) are served as-is; a derivative set would drop the animation.
    if (meta.animated) {
      await originalUpload;
      const inserted = await pool.query(
        `INSERT INTO media_assets (sha256, kind, canonical_key, original_key, width, height, bytes_before, bytes_after)
         VALUES ($1, 'image', $2, $2, $3, $4, $5, $5) RETURNING *`,
        [hash, originalKey, meta.width, meta.height, buf.length]
      );

      return res.json(payload(inserted.rows[0]));
    }

    const set = await derivatives(buf, hash, meta);

    // Uploaded in parallel, and without a preceding exists() check. Keys are
    // content-addressed so a repeat PUT writes identical bytes; paying a HEAD to
    // avoid it would double the round trips, and round trips are what this route
    // actually spends its time on.
    await Promise.all(set.map((derivative) => put(derivative.key, derivative.body, derivative.contentType)));

    const bytesAfter = set.reduce((total, derivative) => total + derivative.body.length, 0);

    await originalUpload;

    const social = set.find((derivative) => derivative.key.endsWith(".jpg")) || set[0];

    const inserted = await pool.query(
      `INSERT INTO media_assets
         (sha256, kind, base_path, canonical_key, original_key, width, height, bytes_before, bytes_after)
       VALUES ($1, 'image', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [hash, `img/${hash}`, social.key, originalKey, meta.width, meta.height, buf.length, bytesAfter]
    );

    res.json(payload(inserted.rows[0]));
  } catch (err) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File is larger than 25 MB" });
    }

    console.error("MEDIA UPLOAD ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || "Upload failed" });
  }
});

export default router;
