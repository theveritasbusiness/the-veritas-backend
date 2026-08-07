import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import compression from "compression";

import articleRoutes from "./routes/articles.js";
import editorRoutes from "./routes/editors.js";
import electionRoutes from "./routes/electionRoutes.js";
import shortRoutes from "./routes/shorts.js";
import subcategoryRoutes from "./routes/subcategories.js";

dotenv.config();

const app = express();

app.use(compression());

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://theveritas.netlify.app",
      "https://theveritas.in",
      "https://www.theveritas.in",
      "http://www.theveritas.in",
      "http://theveritas.in",
      "http://localhost:3001"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  })
);

app.use(express.json());

app.use("/articles", articleRoutes);
app.use("/editors", editorRoutes);
app.use("/api/elections", electionRoutes);
app.use("/shorts", shortRoutes);
app.use("/subcategories", subcategoryRoutes);

import pool from "./db.js";

app.get("/", (req, res) => {
  res.send("Veritas backend running");
});

app.get("/db-test", async (req, res) => {
  try {
    const dbUrl = process.env.DATABASE_URL || "NOT_SET";
    const maskedUrl = dbUrl !== "NOT_SET" ? dbUrl.replace(/:([^:@]+)@/, ":****@") : "NOT_SET";
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "connected", time: result.rows[0].now, databaseUrl: maskedUrl });
  } catch (err) {
    const dbUrl = process.env.DATABASE_URL || "NOT_SET";
    const maskedUrl = dbUrl !== "NOT_SET" ? dbUrl.replace(/:([^:@]+)@/, ":****@") : "NOT_SET";
    res.status(500).json({ status: "error", message: err.message, code: err.code, databaseUrl: maskedUrl });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
