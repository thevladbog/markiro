import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "docs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // React surfaces only — apps/api and packages/{db,domain} have no components.
    // The plugin also ships the React Compiler rules; we opt in to just these two
    // for now, so an accidental mount-only effect is caught rather than assumed.
    files: ["apps/{admin,kiosk,station}/**/*.{ts,tsx}", "packages/{email,ui}/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["**/test/**", "**/emails/**", "**/vitest.config.ts", "**/drizzle*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
