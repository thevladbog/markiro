import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export const forwardRuntimeDescriptor = (executorSha) => ({
  version: 1,
  executorSha,
  dockerExecutable: "/usr/bin/docker",
  endpoint: "unix:///var/run/docker.sock",
  image: `sha256:${"e".repeat(64)}`,
  provenance: "live-source",
});
export async function provisionForwardRuntimes(f) {
  const originals = {
    "backup-runtime.json": forwardRuntimeDescriptor(
      f.u.records.original.current.identity.executorSha,
    ),
    [`recovery-backup-runtime-${f.input.originalPredecessor.identity.operationId}.json`]:
      forwardRuntimeDescriptor(f.input.originalPredecessor.identity.executorSha),
    [`upgrade-backup-runtime-${f.input.failed.identity.operationId}.json`]:
      forwardRuntimeDescriptor(f.input.failed.identity.executorSha),
  };
  const name = `forward-backup-runtime-${f.input.identity.operationId}.json`;
  for (const [path, value] of Object.entries({
    ...originals,
    [name]: forwardRuntimeDescriptor(f.input.identity.executorSha),
  }))
    await writeFile(join(f.root, path), JSON.stringify(value), { mode: 0o600 });
  return { originals, name };
}
