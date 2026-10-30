import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonical, ensure, keys, hash } from "../backup/schemas.mjs";
import { readPrivateFile } from "./files.mjs";
import { validateConfigurationBaseline } from "./configuration-plan.mjs";
import { resolveConfigurationRuntime } from "./configuration-chain.mjs";

export async function readConfigurationHead(root) {
  try {
    await lstat(join(root, "config-index.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readPrivateFile(root, "config-index.json");
  const index = JSON.parse(bytes);
  ensure(Buffer.from(JSON.stringify(index) + "\n").equals(bytes));
  keys(index, ["version", "kind", "head"]);
  ensure(index.version === 1 && index.kind === "platform-configuration-index");
  keys(index.head, ["operationId", "receiptSha256"]);
  ensure(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      index.head.operationId,
    ) && hash(index.head.receiptSha256),
  );
  return index.head;
}

/** Bind new operations to the exact current chain, never a stale original API ID. */
export async function resolveBoundConfigurationRuntime(input) {
  try {
    canonical(input);
    keys(input, ["root", "baseline", "expectedHead"]);
    const { root, baseline, expectedHead } = input;
    validateConfigurationBaseline(baseline);
    const before = await readConfigurationHead(root);
    ensure(canonical(before) === canonical(expectedHead));
    const current = await resolveConfigurationRuntime({ root, baseline });
    ensure(canonical(await readConfigurationHead(root)) === canonical(before));
    return current;
  } catch {
    const error = new Error("Current configuration source rejected.");
    error.code = "ERR_CURRENT_CONFIGURATION_SOURCE";
    throw error;
  }
}
