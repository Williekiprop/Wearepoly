// src/app.ts
import path from "path";
import express from "express";
import cors from "cors";
import fs from "fs";
import router from "./routes"; // Make sure your router exports Express.Router()

const app = express();

// -----------------------------
// 1️⃣ Frontend path (Render-ready)
// -----------------------------
const frontendPath = path.join(__dirname, "../../polymarket-bot/dist");
console.log("Serving frontend from:", frontendPath);
console.log("Dist folder exists?", fs.existsSync(frontendPath));
console.log("index.html exists?", fs.existsSync(path.join(frontendPath, "index.html")));

// -----------------------------
// 2️⃣ Serve static frontend files
// -----------------------------
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.error("❌ Frontend dist folder not found! Make sure frontend is built before running backend.");
}

// -----------------------------
// 3️⃣ Enable CORS
// -----------------------------
app.use(cors({ origin: "*" })); // Restrict later to your frontend URL

// -----------------------------
// 4️⃣ Parse request bodies
// -----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -----------------------------
// 5️⃣ API routes
// -----------------------------
app.use("/api", router);

// -----------------------------
// 6️⃣ Catch-all route for SPA
// -----------------------------
app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");
  console.log("Catch-all: serving index.html from:", indexPath);

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    console.error("❌ index.html NOT FOUND");
    res.status(500).send("Frontend not built");
  }
});

// -----------------------------
// 7️⃣ Start server
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (!process.env.PORT) console.log("Running in Replit/local mode");
});

export default app;
