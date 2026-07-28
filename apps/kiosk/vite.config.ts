import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5373, // admin is 5173, station 5273
    strictPort: true,
    proxy: {
      // Nest controllers are root-mounted with no global prefix
      // (@Controller("kiosk") -> /kiosk), so strip the /api prefix the client
      // uses. The kiosk has no Better Auth routes, so one catch-all suffices.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: { target: "es2023", outDir: "dist" },
});
