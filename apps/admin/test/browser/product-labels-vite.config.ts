import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import base from "./vite.config.js";
import { validationReprocessingFixture } from "./validation-reprocessing-fixture.js";
// This worktree may use an ignored facade over the existing pnpm store.
export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), validationReprocessingFixture()],
  server: {
    fs: {
      allow: [
        resolve(import.meta.dirname, "../../../.."),
        realpathSync(resolve(import.meta.dirname, "../../../../node_modules/.pnpm")),
      ],
    },
  },
});
