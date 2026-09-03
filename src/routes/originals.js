import express from "express";
import pool from "../db.js";
import { requireAuth } from "../auth.js";

const router = express.Router();
let ensured = false;

// Originals are their own content type, not articles: no slug, category, hero
// image or content blocks. The table is created on first use, the same way the
// shorts table is, so no separate migration step is needed on deploy.
async function ensureOriginalsTable() {
  if (ensured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS originals (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      youtube_url TEXT NOT NULL,
      youtube_video_id TEXT NOT NULL,
      article_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Added after the table shipped, so tables created by the first release need
  // it too. ON DELETE is deliberately not a constraint: an Original outlives
  // the article it points at, and a dangling id simply reads as unconnected.
  await pool.query(`ALTER TABLE originals ADD COLUMN IF NOT EXISTS article_id INTEGER`);

  ensured = true;
}

const ORIGINAL_COLUMNS =
  "id, title, description, youtube_url, youtube_video_id, article_id, created_at, updated_at";

// Reads join the connected article so the slug is always current: storing a
// copy of it here would go stale the moment an article is re-slugged.
const SELECT_ORIGINALS = `
  SELECT
    o.id, o.title, o.description, o.youtube_url, o.youtube_video_id,
    o.article_id, o.created_at, o.updated_at,
    a.slug AS article_slug,
    a.title AS article_title
  FROM originals o
  LEFT JOIN articles a ON a.id = o.article_id
`;

// A YouTube video id is always 11 characters of [A-Za-z0-9_-].
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Parses the normal YouTube link formats without calling the YouTube API.
// Accepts youtube.com/watch?v=..., youtu.be/..., and the embed/shorts/live
// paths an editor may paste from the browser address bar.
export function parseYouTubeUrl(rawUrl = "") {
  const input = String(rawUrl || "").trim();

  if (!input) {
    throw new Error("YouTube link is required");
  }

  let url;

  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("Please enter a valid YouTube link");
  }

  const host = url.hostname.replace(/^(www|m|music)\./i, "").toLowerCase();
  const pathname = url.pathname || "";
  let videoId = "";

  if (host === "youtu.be") {
    videoId = pathname.split("/").filter(Boolean)[0] || "";
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const pathMatch = pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/i);
    videoId = pathMatch?.[1] || url.searchParams.get("v") || "";
  } else {
    throw new Error("Only YouTube links are supported");
  }

  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error("Please enter a valid YouTube link");
  }

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function readOriginalBody(body = {}) {
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();

  if (!title) {
    throw new Error("Title is required");
  }

  const parsed = parseYouTubeUrl(body.youtube_url ?? body.url);

  return {
    title,
    description,
    youtube_url: parsed.url,
    youtube_video_id: parsed.videoId,
    article_id: readArticleId(body.article_id)
  };
}

// Connecting an article is optional; anything that is not a positive integer
// clears the link rather than failing the save.
function readArticleId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// 400 for anything the editor can fix by retyping the form, 500 otherwise.
function respondWithError(res, label, error) {
  const message = error?.message || "Database error";
  const status = /required|supported|valid|invalid/i.test(message) ? 400 : 500;

  console.error(`${label}:`, message);
  res.status(status).json({ error: status === 400 ? message : "Database error" });
}

router.get("/", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    await ensureOriginalsTable();

    const result = await pool.query(`
      ${SELECT_ORIGINALS}
      ORDER BY o.created_at DESC, o.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("ORIGINALS FETCH ERROR:", error?.message || error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/admin", requireAuth, async (_req, res) => {
  try {
    await ensureOriginalsTable();

    const result = await pool.query(`
      ${SELECT_ORIGINALS}
      ORDER BY o.created_at DESC, o.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("ADMIN ORIGINALS FETCH ERROR:", error?.message || error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/admin/:id", requireAuth, async (req, res) => {
  try {
    await ensureOriginalsTable();

    const result = await pool.query(
      `
      ${SELECT_ORIGINALS}
      WHERE o.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Original not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ADMIN ORIGINAL FETCH ERROR:", error?.message || error);
    res.status(500).json({ error: "Database error" });
  }
});

// Declared after /admin so the literal route wins over the id parameter.
router.get("/:id", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    await ensureOriginalsTable();

    const result = await pool.query(
      `
      ${SELECT_ORIGINALS}
      WHERE o.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Original not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ORIGINAL FETCH ERROR:", error?.message || error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const original = readOriginalBody(req.body);

    await ensureOriginalsTable();

    const result = await pool.query(
      `
      INSERT INTO originals (title, description, youtube_url, youtube_video_id, article_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING ${ORIGINAL_COLUMNS}
      `,
      [
        original.title,
        original.description,
        original.youtube_url,
        original.youtube_video_id,
        original.article_id
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    respondWithError(res, "ORIGINALS CREATE ERROR", error);
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const original = readOriginalBody(req.body);

    await ensureOriginalsTable();

    const result = await pool.query(
      `
      UPDATE originals
      SET title = $1, description = $2, youtube_url = $3, youtube_video_id = $4,
          article_id = $5, updated_at = NOW()
      WHERE id = $6
      RETURNING ${ORIGINAL_COLUMNS}
      `,
      [
        original.title,
        original.description,
        original.youtube_url,
        original.youtube_video_id,
        original.article_id,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Original not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    respondWithError(res, "ORIGINALS UPDATE ERROR", error);
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await ensureOriginalsTable();

    const result = await pool.query(
      `
      DELETE FROM originals
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Original not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("ORIGINALS DELETE ERROR:", error?.message || error);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
