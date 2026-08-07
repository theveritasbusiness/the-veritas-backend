import pkg from "pg";
const { Pool } = pkg;

// Prioritize Railway internal networking (DATABASE_URL -> postgres.railway.internal) to avoid public proxy egress
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_PUBLIC_URL;

// Railway internal hostnames (postgres.railway.internal) and localhost do NOT use SSL.
// Public proxy hostnames (e.g., proxy.rlwy.net) require SSL.
const isLocalOrInternal =
  !connectionString ||
  connectionString.includes("localhost") ||
  connectionString.includes("127.0.0.1") ||
  connectionString.includes(".railway.internal");

const pool = new Pool({
  connectionString,
  ssl: isLocalOrInternal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected database error:", err);
});

export default pool;
