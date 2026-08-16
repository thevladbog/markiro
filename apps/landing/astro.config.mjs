import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://markiro.app",
  output: "static",
  build: {
    assets: "assets",
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
      target: "es2023",
    },
  },
});
