import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const REQUIRED_ROUTES = [
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json",
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-v",
];
const FORBIDDEN_ROUTE = "releases.markiro.app";

export async function verifySeedUpdaterBinary(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BINARY_BYTES) {
    throw new Error("Invalid Station seed binary");
  }

  const handle = await open(path, "r");
  try {
    const contents = await handle.readFile();
    if (
      contents.includes(Buffer.from(FORBIDDEN_ROUTE)) ||
      REQUIRED_ROUTES.some((route) => !contents.includes(Buffer.from(route)))
    ) {
      throw new Error("Invalid Station seed updater routes");
    }
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    process.stderr.write("Usage: verify-seed-updater-binary.mjs <binary>\n");
    process.exitCode = 1;
  } else {
    try {
      await verifySeedUpdaterBinary(path);
    } catch {
      process.stderr.write("Station seed binary verification failed\n");
      process.exitCode = 1;
    }
  }
}
