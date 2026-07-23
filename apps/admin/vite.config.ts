import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev-server proxy note (see apps/api/src/auth/auth.setup.ts /
 * apps/api/src/main.ts): Better Auth is mounted directly on the Express
 * instance at the literal path `/api/auth/*splat`, but every other API
 * route is registered on Nest controllers with no global prefix (e.g.
 * `@Controller("counterparties")` -> `/counterparties`, not
 * `/api/counterparties`). The admin app's own convention (src/api/client.ts)
 * is to call everything under a single `/api` base, so two proxy rules are
 * needed: the more specific `/api/auth` entry forwards untouched (it already
 * matches the backend's real path), while the catch-all `/api` entry strips
 * the prefix before forwarding to the backend's root-mounted routes. Vite
 * matches proxy keys in declaration order, so `/api/auth` must come first.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/auth": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
