import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  clearScreen: false,
  server: { port: 5373, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
