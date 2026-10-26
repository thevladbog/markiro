import assert from "node:assert/strict";
import { appendFile, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { executeForwardPreparation } from "../host/forward-preparation.mjs";
import { withHeldForwardState } from "../host/forward-state.mjs";
import { forwardPreparationFixture } from "./forward-preparation-fixture.mjs";
import { digest } from "../backup/schemas.mjs";
const run = (f) => executeForwardPreparation(f.context, f.adapters, f.options);
test("preparation reaches fresh seq6 proof through source hold and independent canonical backup readback only", async (t) => {
  const f = await forwardPreparationFixture(t);
  assert.deepEqual(await run(f), f.input.identity);
  const state = JSON.parse(
    await readFile(
      join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json"),
    ),
  );
  assert.equal(state.sequence, 6);
  assert.equal(state.migrationEntered, true);
  assert.equal(state.phase, "backup-verified");
  assert.equal(state.status, "completed");
  assert.equal(f.trace.filter((n) => n === "createBackup").length, 1);
  assert.equal(f.trace.filter((n) => n === "inspectSource").length, 4);
  assert.ok(
    f.trace.every((n) =>
      ["verifyAdmission", "inspectSource", "inspectSchema", "createBackup"].includes(n),
    ),
  );
});
for (const kind of [
  "source-1",
  "source-2",
  "source-3",
  "source-4",
  "verifyAdmission",
  "inspectSchema",
  "createBackup",
  "config",
  "ledger",
  "archive",
  "cleanup-proof",
])
  test(`preparation rejects ${kind} and never grants activation`, async (t) => {
    const f = await forwardPreparationFixture(t, kind);
    if (kind === "config")
      await appendFile(f.context.configuration.runtimeSnapshot.path, "#changed\n");
    if (kind === "ledger")
      f.adapters.inspectSchema = (ctx, cap) =>
        withHeldForwardState(cap, async () => ({
          version: 1,
          kind: "platform-forward-migration-observation",
          postgresId: f.input.baseline.containers.postgres,
          productProofSha256: f.productMigrationProof.proofSha256,
          schema: f.input.baseline.schema,
          rows: f.productMigrationProof.entries.map(({ hash, createdAt }, i) => ({
            hash: i === 0 ? "f".repeat(64) : hash,
            createdAt,
          })),
        }));
    if (["archive", "cleanup-proof"].includes(kind)) {
      const create = f.adapters.createBackup;
      f.adapters.createBackup = async (ctx, cap) => {
        const value = structuredClone(await create(ctx, cap));
        if (kind === "archive")
          await writeFile(value.backup.archivePath, "corrupted", { mode: 0o600 });
        else {
          const evidence = JSON.parse(await readFile(value.restoreEvidence.evidencePath));
          evidence.cleanup.verified = false;
          const bytes = Buffer.from(JSON.stringify(evidence));
          await writeFile(value.restoreEvidence.evidencePath, bytes, { mode: 0o600 });
          value.restoreEvidence.evidenceSha256 = digest(bytes);
        }
        return value;
      };
    }
    await assert.rejects(run(f));
    const state = JSON.parse(
      await readFile(
        join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json"),
      ),
    );
    assert.equal(state.status, "recovery-required");
    const failure = await readFile(join(f.directory, "failure.json"), "utf8");
    assert.doesNotMatch(failure, /PRIVATE-PREPARE-FAILURE|corrupted/u);
    if (
      [
        "source-1",
        "source-2",
        "source-3",
        "config",
        "ledger",
        "verifyAdmission",
        "inspectSchema",
      ].includes(kind)
    )
      assert.equal(f.trace.includes("createBackup"), false);
  });
test("unconfirmed backup producer records first failure and retains lock without cleanup", async (t) => {
  const f = await forwardPreparationFixture(t);
  f.adapters.createBackup = (_ctx, cap) =>
    withHeldForwardState(cap, async () => {
      throw Object.assign(new Error("PRIVATE-UNREAPED-PRODUCER"), { terminationConfirmed: false });
    });
  await assert.rejects(run(f), (e) => e.durabilityUncertain === true);
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  const state = JSON.parse(
    await readFile(
      join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json"),
    ),
  );
  assert.equal(state.status, "entered");
  assert.equal(state.sequence, 5);
  assert.equal(f.trace.filter((n) => n === "inspectSource").length, 3);
  assert.doesNotMatch(
    await readFile(join(f.directory, "failure.json"), "utf8"),
    /PRIVATE-UNREAPED/u,
  );
});
test("unwritable first diagnostic retains lock and original bytes", async (t) => {
  const f = await forwardPreparationFixture(t, "verifyAdmission");
  await writeFile(join(f.directory, "failure.json"), "existing-first-failure", { mode: 0o600 });
  await assert.rejects(run(f), (e) => e.durabilityUncertain === true);
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.equal(await readFile(join(f.directory, "failure.json"), "utf8"), "existing-first-failure");
});
for (const method of ["startOldApi", "stopOldEdge", "migrate", "restoreOverLive"])
  test(`preparation has no executable ${method} surface`, async (t) => {
    const f = await forwardPreparationFixture(t);
    f.adapters[method] = () => assert.fail("forbidden workload action");
    await assert.rejects(run(f));
    assert.equal(f.trace.length, 0);
  });

for (const diagnosticFails of [false, true])
  test(`coordinator supplies a sticky first diagnostic before nested cleanup (diagnosticFails=${diagnosticFails})`, async (t) => {
    const { noteHostProcessFailure } = await import("../host/failure-diagnostic.mjs");
    const f = await forwardPreparationFixture(t);
    const path = join(f.directory, "failure.json");
    if (diagnosticFails)
      await (await import("node:fs/promises")).writeFile(path, "retained-first", { mode: 0o600 });
    let cleanup = false;
    f.adapters.createBackup = async (_context, _cap, persist) => {
      const first = noteHostProcessFailure(
        Object.assign(new Error("PRIVATE-FIRST"), { terminationConfirmed: true }),
        "/usr/bin/docker",
        42,
      );
      await persist(first);
      const bytes = await readFile(path, "utf8");
      assert.equal(JSON.parse(bytes).exitStatus, 42);
      cleanup = true;
      throw noteHostProcessFailure(
        Object.assign(new Error("PRIVATE-SECOND"), { durabilityUncertain: true }),
        "/usr/bin/docker",
        43,
      );
    };
    await assert.rejects(run(f));
    assert.equal(cleanup, !diagnosticFails);
    const bytes = await readFile(path, "utf8");
    if (diagnosticFails) assert.equal(bytes, "retained-first");
    else {
      assert.equal(JSON.parse(bytes).exitStatus, 42);
      assert.doesNotMatch(bytes, /PRIVATE-FIRST|PRIVATE-SECOND/u);
    }
    assert.ok(await lstat(join(f.root, ".deploy.lock")));
  });
