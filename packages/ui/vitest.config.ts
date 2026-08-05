import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "ui-test-raw-css",
      enforce: "pre",
      resolveId(source) {
        return source === "virtual:ui-component-styles" ? `\0${source}` : undefined;
      },
      load(id) {
        if (id !== "\0virtual:ui-component-styles") return undefined;

        const styles = readFileSync(new URL("./src/components.css", import.meta.url), "utf8");
        return `export default ${JSON.stringify(styles)}`;
      },
    },
    react(),
  ],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
  },
});
