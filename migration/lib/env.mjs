// Loads secrets from ../.env.migration WITHOUT ever printing them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const WORKSPACE = path.resolve(ROOT, "..", "..");
const ENV_FILE = path.resolve(WORKSPACE, ".env.migration");

if (fs.existsSync(ENV_FILE)) {
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function need(...keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`\nMissing required config: ${missing.join(", ")}`);
    console.error(`Add them to ${ENV_FILE} and re-run.\n`);
    process.exit(1);
  }
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

export const OUT = process.env.OUT_DIR || path.join(WORKSPACE, "migration-data", "out");
export const ARCHIVE = process.env.ARCHIVE_DIR || path.join(WORKSPACE, "migration-data", "archive");

export function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(n) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export async function retry(fn, { tries = 5, label = "op" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === tries) break;
      const wait = Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400);
      console.warn(`  retry ${attempt}/${tries - 1} for ${label} in ${wait}ms — ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}
