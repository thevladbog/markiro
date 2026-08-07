import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stationRequire = createRequire(resolve(repositoryRoot, "apps/station/package.json"));
const { default: react } = await import(
  pathToFileURL(stationRequire.resolve("@vitejs/plugin-react")).href
);

export default {
  root: resolve(repositoryRoot, "apps/station"),
  envDir: repositoryRoot,
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      {
        find: "@markiro/ui/styles.css",
        replacement: resolve(repositoryRoot, "packages/ui/src/styles.css"),
      },
      {
        find: /^@markiro\/ui$/,
        replacement: resolve(repositoryRoot, "packages/ui/src/index.ts"),
      },
      {
        find: "@markiro/db/station-sqlite",
        replacement: resolve(repositoryRoot, "packages/db/src/station-sqlite.ts"),
      },
    ],
  },
  build: {
    target: "es2023",
    outDir: "/tmp/markiro-station-touch-acceptance-dist",
    emptyOutDir: true,
  },
};
