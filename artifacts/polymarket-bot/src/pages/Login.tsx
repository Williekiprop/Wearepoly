import React, { useState } from "react";
import { Terminal, Lock } from "lucide-react";
import { motion } from "framer-motion";

interface LoginProps {
  onLogin: (token: string) => void;
}

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

export default function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json() as { token?: string; error?: string };

      if (!res.ok || !data.token) {
        setError(data.error ?? "Login failed");
        return;
      }

      localStorage.setItem("AUTH_TOKEN", data.token);
      onLogin(data.token);
    } catch {
      setError("Network error — check connection");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-[#0d1f0d] border border-[#00ff41]/30 rounded flex items-center justify-center">
            <Terminal className="w-5 h-5 text-[#00ff41]" />
          </div>
          <div>
            <div className="text-[#00ff41] font-mono font-bold text-lg leading-none">
              POLYMARKET_BTC
            </div>
            <div className="text-[#00ff41]/50 font-mono text-xs">EDGE_ENGINE v1.0.5</div>
          </div>
        </div>

        {/* Login card */}
        <div className="bg-[#0a0a0a] border border-[#1a2a1a] rounded-lg p-6">
          <div className="flex items-center gap-2 mb-6">
            <Lock className="w-4 h-4 text-[#00ff41]/60" />
            <span className="text-[#00ff41]/60 font-mono text-sm uppercase tracking-widest">
              Authentication Required
            </span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[#00ff41]/50 font-mono text-xs uppercase tracking-widest mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full bg-[#0d1f0d] border border-[#1a3a1a] rounded px-3 py-2.5 text-[#00ff41] font-mono text-sm focus:outline-none focus:border-[#00ff41]/60 placeholder-[#00ff41]/20 transition-colors"
                placeholder="user@example.com"
              />
            </div>

            <div>
              <label className="block text-[#00ff41]/50 font-mono text-xs uppercase tracking-widest mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full bg-[#0d1f0d] border border-[#1a3a1a] rounded px-3 py-2.5 text-[#00ff41] font-mono text-sm focus:outline-none focus:border-[#00ff41]/60 placeholder-[#00ff41]/20 transition-colors"
                placeholder="••••••••••"
              />
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-red-950/40 border border-red-800/50 rounded px-3 py-2 text-red-400 font-mono text-xs"
              >
                ✗ {error}
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#00ff41]/10 hover:bg-[#00ff41]/20 border border-[#00ff41]/40 hover:border-[#00ff41]/70 text-[#00ff41] font-mono text-sm py-2.5 rounded transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-widest"
            >
              {loading ? "Authenticating..." : "Access System"}
            </button>
          </form>
        </div>

        <div className="mt-4 text-center text-[#00ff41]/20 font-mono text-xs">
          Unauthorized access is prohibited
        </div>
      </motion.div>
    </div>
  );
}
