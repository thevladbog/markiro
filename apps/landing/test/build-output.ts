import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * A fresh output directory for a test build of the site, inside the app's ignored
 * `node_modules/.cache`. Astro moves prerendered assets from `.astro/` into the output
 * with `rename`, which fails with EXDEV when the output sits on another file system,
 * as `/tmp` does on the CI runner.
 */
export function testBuildDirectory(prefix: string): string {
  const parent = path.join(appRoot, "node_modules/.cache/landing-test-builds");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, prefix));
}
