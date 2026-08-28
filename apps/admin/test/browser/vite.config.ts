import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const installedModulesRoot = realpathSync(resolve(repositoryRoot, "node_modules"));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@markiro\/domain$/,
        replacement: resolve(repositoryRoot, "packages/domain/src/index.ts"),
      },
      {
        find: /^@markiro\/ui$/,
        replacement: resolve(repositoryRoot, "packages/ui/src/index.ts"),
      },
      {
        find: /^@markiro\/ui\/styles\.css$/,
        replacement: resolve(repositoryRoot, "packages/ui/src/styles.css"),
      },
    ],
  },
  server: {
    fs: { allow: [repositoryRoot, installedModulesRoot] },
  },
});
