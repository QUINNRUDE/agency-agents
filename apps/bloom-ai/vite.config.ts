import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `VITE_PREVIEW=1 vite build --mode preview` builds a static, server-less preview (demo data) into dist-preview/.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "preview" ? "./" : "/",
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:4400", changeOrigin: false } },
  },
  build: { outDir: mode === "preview" ? "dist-preview" : "dist", chunkSizeWarningLimit: 900 },
}));
