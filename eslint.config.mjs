import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-us/**", "**/coverage/**", "**/.turbo/**", "docs/**"] },
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
    files: ["apps/{admin,kiosk,signer,station}/**/*.{ts,tsx}", "packages/{email,ui}/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/admin/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='input']",
          message:
            "Use the appropriate @markiro/ui control (Input, Checkbox, RadioGroup, or DatePicker) instead of a native input.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use @markiro/ui Select instead of a native select.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message: "Add and use a custom @markiro/ui Textarea instead of a native textarea.",
        },
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: "Use @markiro/ui Button or IconButton instead of a native button.",
        },
        {
          selector: "JSXOpeningElement[name.name='option']",
          message: "Use @markiro/ui Select instead of native option elements.",
        },
        {
          selector: "JSXOpeningElement[name.name='datalist']",
          message: "Use a custom @markiro/ui Combobox instead of a native datalist.",
        },
      ],
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["**/test/**", "**/emails/**", "**/vitest.config.ts", "**/drizzle*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
