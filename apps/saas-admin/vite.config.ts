import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^js-yaml$/,
        replacement: fileURLToPath(new URL("./src/lib/js-yaml-default.ts", import.meta.url)),
      },
    ],
  },
  server: {
    proxy: {
      "/api/platform-auth": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/api/platform": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
