process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

// ✅ Use stable path (Render-safe)
const frontendPath = path.resolve(process.cwd(), "artifacts/polymarket-bot/dist");

console.log("Serving frontend from:", frontendPath);
console.log("Dist exists?", fs.existsSync(frontendPath));
console.log("Index exists?", fs.existsSync(path.join(frontendPath, "index.html")));

// Static files
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.error("❌ Frontend dist folder not found!");
}

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", router);

// SPA fallback
app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    console.error("❌ index.html NOT FOUND");
    res.status(500).send("Frontend not built");
  }
});

// 🚀 CRITICAL: Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;
