import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import base from "./vite.config.js";
// This worktree may use an ignored facade over the existing pnpm store.
export default defineConfig({
  ...base,
  server: {
    fs: {
      allow: [
        resolve(import.meta.dirname, "../../../.."),
        realpathSync(resolve(import.meta.dirname, "../../../../node_modules/.pnpm")),
      ],
    },
  },
});
