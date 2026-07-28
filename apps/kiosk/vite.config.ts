import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import type { VitePWAOptions } from "vite-plugin-pwa";

/**
 * The kiosk installs as a PWA on the tablet it lives on. Exported so
 * `test/pwa-config.test.ts` can assert it: jsdom has no service-worker
 * registry, so this object — which is what becomes `manifest.webmanifest`
 * and `sw.js` — is the only meaningful thing to pin down.
 *
 * The icons are the Markiro mark from
 * `docs/design-briefs/design_handoff_markiro/design-system/assets/mark.svg`
 * rendered to PNG; the maskable one drops the mark's own frame (the platform
 * mask supplies the silhouette) and keeps the modules inside the inner-80%
 * safe circle.
 */
export const pwaOptions = {
  // Nobody stands at an unattended kiosk to accept an update prompt, so the
  // new worker takes over as soon as it has precached the new build.
  registerType: "autoUpdate",
  injectRegister: "script-defer",
  manifest: {
    id: "/",
    name: "Маркиро — Киоск",
    short_name: "Киоск",
    description: "Самообслуживание: бейдж и коды Честного знака",
    lang: "ru",
    // Chromeless on a wall-mounted tablet, and usable however it is hung:
    // `orientationOf` in src/screens/Cart.tsx lays out both 1180x800 and
    // 800x1180, so the manifest must not pin one of them.
    display: "fullscreen",
    orientation: "any",
    start_url: "/",
    scope: "/",
    // --surface-page under [data-theme="dark"] in @markiro/ui tokens.css —
    // the splash must not flash light before React mounts.
    theme_color: "#131216",
    background_color: "#131216",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    // The whole shell, fonts included — there is no CDN to fall back on.
    globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
    navigateFallback: "index.html",

    // DO NOT add caching for /api/ here, however reasonable "better offline
    // support" sounds. The kiosk's offline story is the IndexedDB snapshot
    // (src/store) plus the deviceSeq-ordered outbox (src/sync) — never HTTP
    // caching. `POST /kiosk/orders` is idempotent only on
    // (tenantId, kioskId, deviceSeq), which the queue owns; a cache in front
    // of it would either replay a submission the queue believes it already
    // sent, or hand back a cached success for one that never reached the
    // server. A stale `GET /kiosk/bootstrap` is just as bad: the staleness
    // gates read its `generatedAt`, and a cached response freezes it.
    // Hence no runtime caching at all, and the SPA navigation fallback is
    // denied for /api/ so an API request can never be answered with
    // index.html.
    runtimeCaching: [],
    navigateFallbackDenylist: [/^\/api\//],
  },
} satisfies Partial<VitePWAOptions>;

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
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
