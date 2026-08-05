import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // The admin suites share a browser-like JSDOM process and many Radix
    // portals. Serialising files prevents CI CPU contention from turning
    // legitimate 200–500ms interaction tests into 5s timeouts.
    fileParallelism: false,
    // Plan 04 Task 5 adds the first plain-`.ts` (no-JSX) admin test file
    // (`labels-raster.test.ts`, covering `labels/rasterizer.ts` and
    // `labels/fontCoverage.ts`) alongside the existing `.test.tsx` component
    // suites, so both extensions must be picked up.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
