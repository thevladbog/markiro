import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function createUsEntryBoundary(): Plugin {
  const adminSource = fileURLToPath(new URL("./src/", import.meta.url));
  const entryBoundary = {
    name: "us-entry-boundary",
    enforce: "pre",
    transform(_source: string, id: string) {
      if (
        id.startsWith(adminSource) &&
        !id.startsWith(`${adminSource}us/`) &&
        !id.startsWith(`${adminSource}assets/`)
      ) {
        this.error("US entry cannot import RU application code");
      }
    },
  } satisfies Plugin;
  return entryBoundary;
}
