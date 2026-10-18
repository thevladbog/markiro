import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Runs the window-mode gallery (`window-mode.harness.tsx`), which the package's own config does not match. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/harness/window-mode/*.harness.tsx"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
  },
});
