import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? "";
const JWT_SECRET = process.env.JWT_SECRET ?? "fallback-insecure-secret";
const TOKEN_TTL = "7d";

router.post("/login", async (req, res): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const emailMatch = email.trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase();
  const passwordMatch = ADMIN_PASSWORD_HASH
    ? await bcrypt.compare(password, ADMIN_PASSWORD_HASH)
    : false;

  if (!emailMatch || !passwordMatch) {
    await new Promise(r => setTimeout(r, 400)); // constant-time delay
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.json({ token });
});

router.post("/logout", (_req, res) => {
  res.json({ ok: true });
});

export default router;
