import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  plugins: [react(), viteSingleFile()],
  build: {
    target: "esnext",
    outDir: resolve(import.meta.dirname, "dist-web"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/web/triage-app.html"),
    },
  },
});
