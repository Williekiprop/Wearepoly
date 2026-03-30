import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";

const app: Express = express();

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

if (!process.env.PORT) {
  console.log("Running in Replit/local mode");
}
