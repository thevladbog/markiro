import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "ui-test-raw-css",
      enforce: "pre",
      resolveId(source) {
        return source === "virtual:ui-component-styles" || source === "virtual:ui-token-styles"
          ? `\0${source}`
          : undefined;
      },
      load(id) {
        if (id === "\0virtual:ui-component-styles") {
          const styles = readFileSync(new URL("./src/components.css", import.meta.url), "utf8");
          return `export default ${JSON.stringify(styles)}`;
        }

        if (id === "\0virtual:ui-token-styles") {
          const styles = readFileSync(new URL("./src/tokens.css", import.meta.url), "utf8");
          return `export default ${JSON.stringify(styles)}`;
        }

        return undefined;
      },
    },
    react(),
  ],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
