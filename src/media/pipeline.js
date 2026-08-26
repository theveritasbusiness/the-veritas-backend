import sharp from "sharp";
import crypto from "node:crypto";

// Widths served to readers. 1200 doubles as the social/crawler size.
export const WIDTHS = [400, 800, 1200, 1600];
export const SOCIAL_WIDTH = 1200;
export const ALLOWED = new Set(["jpeg", "jpg", "png", "webp", "avif", "gif", "tiff"]);

export function hashOf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export async function probe(buf) {
  const meta = await sharp(buf).metadata();

  if (!ALLOWED.has(meta.format)) {
    const error = new Error(`Unsupported image format: ${meta.format}`);
    error.status = 415;
    throw error;
  }

  // EXIF orientations 5-8 swap the axes, so report post-rotation dimensions.
  const swapped = meta.orientation >= 5;

  return {
    format: meta.format,
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    animated: (meta.pages ?? 1) > 1
  };
}

export async function derivatives(buf, hash, meta) {
  const widths = WIDTHS.filter((width) => width <= meta.width);

  if (widths.length === 0) {
    widths.push(meta.width);
  }

  const socialWidth = Math.min(SOCIAL_WIDTH, meta.width);

  if (!widths.includes(socialWidth)) {
    widths.push(socialWidth);
  }

  const ordered = [...new Set(widths)].sort((a, b) => a - b);
  const largest = ordered[ordered.length - 1];

  // Decode the source exactly once and downscale to the largest width we need,
  // then derive every size from that intermediate. Decoding per width instead
  // costs ~2x on a 20-megapixel photo, which the editor waits through.
  //
  // .rotate() with no argument bakes EXIF orientation into the pixels here,
  // before sharp drops metadata. Without it, roughly half of any phone-sourced
  // photo set comes out sideways.
  const intermediate = await sharp(buf, { animated: meta.animated })
    .rotate()
    .resize({ width: largest, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const from = () => sharp(intermediate.data, { raw: intermediate.info });

  const out = [];

  for (const width of ordered) {
    const base = from().resize({ width, withoutEnlargement: true });

    // effort 2 rather than a higher value: benchmarked over this site's own
    // images it is both smaller and ~7x faster than effort 4.
    out.push({
      key: `${width}.avif`,
      body: await base.clone().avif({ quality: 50, effort: 2 }).toBuffer(),
      contentType: "image/avif"
    });

    out.push({
      key: `${width}.webp`,
      body: await base.clone().webp({ quality: 78 }).toBuffer(),
      contentType: "image/webp"
    });

    // One JPEG only. It backs <img src> and og:image, because the WhatsApp, X
    // and Facebook link crawlers do not decode AVIF.
    if (width === socialWidth) {
      out.push({
        key: `${width}.jpg`,
        body: await base
          .clone()
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 82, mozjpeg: true, progressive: true })
          .toBuffer(),
        contentType: "image/jpeg"
      });
    }
  }

  return out.map((derivative) => ({ ...derivative, key: `img/${hash}/${derivative.key}` }));
}
