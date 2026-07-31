import pkg from "pg";
const { Pool } = pkg;

const connectionString =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.POSTGRES_URL;

// Right now I am using the proxy hostname of the database in teh backend. 
// I tried internal but it's not working for some reason
// Railway internal hostnames (postgres.railway.internal) and localhost do NOT use SSL.
// Public proxy hostnames (e.g., proxy.rlwy.net) require SSL.
const isLocalOrInternal =
  !connectionString ||
  connectionString.includes("localhost") ||
  connectionString.includes("127.0.0.1") ||
  connectionString.includes("railway.internal");

const pool = new Pool({
  connectionString,
  ssl: isLocalOrInternal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected database error:", err);
});

export default pool;
