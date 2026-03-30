import path from "path";
import express from "express";

const app = express();

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
app.use((req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

if (!process.env.PORT) {
  console.log("Running in Replit/local mode");
}
console.log("Serving frontend from:", frontendPath);
