import { fileURLToPath } from "node:url";
import { childEnvironment, runCommand } from "./admission-process.mjs";
import { exactKeys } from "./release-admission.mjs";
export async function extractReleaseZip(path) {
  try {
    const text = await runCommand(
      "python3",
      ["-I", fileURLToPath(new URL("./admission-archive.py", import.meta.url)), path],
      {
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: childEnvironment(),
      },
    );
    const value = JSON.parse(text);
    if (
      !exactKeys(value, ["platform-manifest.json", "release-evidence.json"]) ||
      Object.values(value).some(
        (item) => typeof item !== "string" || Buffer.byteLength(item) > 256 * 1024,
      )
    )
      throw new Error();
    return {
      manifestText: value["platform-manifest.json"],
      evidenceText: value["release-evidence.json"],
    };
  } catch {
    throw new Error("platform admission failed: archive");
  }
}
