import path from "path";
import express from "express";

const app = express();

const frontendPath = path.join(
  const frontendPath = path.join(
  process.cwd(),
  "artifacts",
  "polymarket-bot",
  "dist"
);
console.log("Frontend path:", frontendPath);

// Serve static files
app.use(express.static(frontendPath));


// ✅ Allow requests from your frontend
app.use(
  cors({
    origin: "*", // later restrict to your frontend URL
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ API routes
app.use("/api", router);

export default app;

// Catch-all (VERY IMPORTANT)
import fs from "fs";

app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  console.log("Trying to serve:", indexPath);

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
console.log("Serving frontend from:", frontendPath);
