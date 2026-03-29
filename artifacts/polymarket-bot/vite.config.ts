import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// 🌍 Detect environment
const isReplit = process.env.REPL_ID !== undefined;
const isProduction = process.env.NODE_ENV === "production";

// ⚙️ Safe environment variables (NO crashes)
const port = Number(process.env.PORT) || 5173;
const basePath = process.env.BASE_PATH || "/";

// 🧠 Optional validation (only in dev, not production)
if (!isProduction) {
  if (!process.env.PORT) {
    console.warn("⚠️ PORT not set, defaulting to 5173");
  }
  if (!process.env.BASE_PATH) {
    console.warn('⚠️ BASE_PATH not set, defaulting to "/"');
  }
}

export default defineConfig(async () => {
  // 🔌 Plugins array
  const plugins = [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
  ];

  // 🧩 Replit-only plugins (DEV only)
  if (!isProduction && isReplit) {
    const { cartographer } = await import("@replit/vite-plugin-cartographer");
    const { devBanner } = await import("@replit/vite-plugin-dev-banner");

    plugins.push(
      cartographer({
        root: path.resolve(import.meta.dirname, ".."),
      }),
      devBanner()
    );
  }

  return {
    base: basePath,

    plugins,

    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(
          import.meta.dirname,
          "..",
          "..",
          "attached_assets"
        ),
      },
      dedupe: ["react", "react-dom"],
    },

    root: path.resolve(import.meta.dirname),

    build: {
      // ✅ IMPORTANT: Render expects simple dist folder
      outDir: "dist",
      emptyOutDir: true,
    },

    server: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },

    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
