import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";

const app: Express = express();
// Serve frontend static files
const frontendPath = path.join(process.cwd(), "../polymarket-bot/dist");

app.use(express.static(frontendPath));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

// Catch-all: send React app for all routes
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});
