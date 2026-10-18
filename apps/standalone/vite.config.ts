import { execFileSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The checkout's short commit, or `undefined` outside git (a source archive). */
function buildCommit(): string | undefined {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

// Tauri serves the built webview from `dist/`. `clearScreen: false` keeps the
// Rust compiler output visible during `tauri dev`; the port is fixed so
// `devUrl` in src-tauri/tauri.conf.json matches. Unlike the cloud station there
// is no build-time API URL: the host is found at run time. The two build
// defines feed the office's «Информация» (`src/office/info/build-info.ts`).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5274, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
  define: {
    __MARKIRO_BUILD_COMMIT__: JSON.stringify(buildCommit() ?? null),
    __MARKIRO_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
});
