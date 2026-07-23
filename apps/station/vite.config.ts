import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built webview from `dist/`. `clearScreen: false` keeps the
// Rust compiler output visible during `tauri dev`. Port is fixed so the Rust
// `devUrl` in tauri.conf.json matches.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
