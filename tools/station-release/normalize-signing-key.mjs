import { readFile } from "node:fs/promises";

const HEADER = "untrusted comment: rsign encrypted secret key\n";

export function normalizeTauriSigningKey(value) {
  const decoded = value.startsWith("untrusted comment:")
    ? value
    : Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
  if (!decoded.startsWith(HEADER)) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY is not a Tauri rsign private key");
  }
  return Buffer.from(decoded, "utf8").toString("base64");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const value = await readFile(0, "utf8");
  try {
    process.stdout.write(normalizeTauriSigningKey(value));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid signing key"}\n`);
    process.exitCode = 1;
  }
}
