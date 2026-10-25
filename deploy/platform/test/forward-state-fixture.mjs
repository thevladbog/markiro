import { mkdir, writeFile, rename, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { forwardFixture } from "./forward-fixture.mjs";
export const forwardMetadata = async (path) => {
  const s = await lstat(path, { bigint: true });
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    uid: Number(s.uid),
    gid: Number(s.gid),
    mode: Number(s.mode & 0o7777n),
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
  };
};
export async function forwardStateFixture(t, patch = {}, supplied) {
  const dir = supplied ? { root: supplied.root } : await privateFixture(t, { nested: true });
  const f = supplied ?? forwardFixture({ root: dir.root });
  const id = f.records.state.admission.identity.operationId,
    recovered = f.input.originalPredecessor.identity.operationId;
  const paths = {
    state: `upgrade-operations/${id}/state.json`,
    beforeActivate: `upgrade-operations/${id}/before-activate.json`,
    prepareConsumption: `upgrade-operations/${id}/prepare-consumption.json`,
    activateConsumption: `upgrade-operations/${id}/activate-consumption.json`,
    index: "upgrade-index.json",
  };
  const retained = new Map();
  const put = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
    retained.set(path, bytes);
  };
  for (const [key, relative] of Object.entries(paths))
    await put(join(dir.root, relative), f.failedBytes[key]);
  for (const phase of ["prepare", "activate"])
    await put(
      join(dirname(dir.root), "upgrade-operations", id, phase, "operation.json"),
      f.failedBytes[`${phase}Operation`],
    );
  for (const [key, relative] of Object.entries({
    original: "state.json",
    acceptedRecovery: "recovery-state.json",
    preparation: "recovery-preparation.json",
    consumption: `recovery-activation-${recovered}.json`,
  }))
    await put(join(dir.root, relative), f.originalPredecessorBytes[key]);
  await put(
    join(dirname(dir.root), "recovery-operations", recovered, "activate", "operation.json"),
    f.originalPredecessorBytes.activationOperation,
  );
  const options = {
    now: () => f.now,
    productMigrationProof: f.productMigrationProof,
    verifyBaseline: async () => {},
    // Local macOS tests inject only the filesystem syscall bridge. The default
    // production bridge must be exercised on Linux in the isolated rehearsal.
    renameIndex: async ({ root, destination, checkpoint }) => {
      await checkpoint("before-rename");
      await rename(join(root, "upgrade-index.json"), join(root, destination));
      await checkpoint("after-rename");
      await checkpoint("source-parent-synced");
      await checkpoint("archive-parent-synced");
      return forwardMetadata(join(root, destination));
    },
    ...patch,
  };
  return { ...f, root: dir.root, options, retained, clock: f };
}
