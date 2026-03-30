import path from "path";
import express from "express";
import cors from "cors";
import fs from "fs";
import router from "./routes";

const app = express();

// Frontend static files
const frontendPath = path.join(
  process.cwd(),
  "artifacts",
  "polymarket-bot",
  "dist"
);
console.log("Serving frontend from:", frontendPath);
console.log("Dist exists:", fs.existsSync(frontendPath));
console.log("Index exists:", fs.existsSync(path.join(frontendPath, "index.html")));

// Serve static files
app.use(express.static(frontendPath));

// Enable CORS
app.use(cors({ origin: "*" }));

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes
app.use("/api", router);

// Catch-all for SPA routing
app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    console.error("❌ index.html NOT FOUND");
    res.status(500).send("Frontend not built");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
if (!process.env.PORT) {
  console.log("Running in Replit/local mode");
}
