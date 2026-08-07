import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import baseConfig from "../../eslint.config.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default [
  ...baseConfig,
  {
    files: ["apps/station/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: resolve(repositoryRoot, "docs/acceptance/station-touch-tsconfig.json"),
        tsconfigRootDir: repositoryRoot,
      },
    },
  },
];
