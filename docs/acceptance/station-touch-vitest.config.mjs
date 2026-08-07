import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default {
  root: resolve(repositoryRoot, "apps/station"),
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
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    execArgv: ["--experimental-sqlite"],
  },
};
