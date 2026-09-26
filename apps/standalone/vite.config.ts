import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built webview from `dist/`. `clearScreen: false` keeps the
// Rust compiler output visible during `tauri dev`; the port is fixed so
// `devUrl` in src-tauri/tauri.conf.json matches. Unlike the cloud station there
// is no build-time API URL: the host is found at run time.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5274, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
