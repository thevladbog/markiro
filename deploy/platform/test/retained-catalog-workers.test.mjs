import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./host-fixtures.mjs";
import { retainedCatalogWorkerFixture } from "./retained-catalog-worker-fixture.mjs";
import { verifyRetainedCatalogWorkers } from "../host/retained-catalog-workers.mjs";

test("only exact stopped independently accepted catalog workers receive mount custody", async (t) => {
  const f = await privateFixture(t, { nested: true }),
    hostRoot = dirname(f.root),
    acceptedOperationId = randomUUID();
  const w = await retainedCatalogWorkerFixture(hostRoot, acceptedOperationId);
  const input = {
    hostRoot,
    acceptedOperationId,
    expected: [w.expected],
    inventory: [w.worker],
    guards: new Map(w.guards.map((g) => [g.path, g.sha256])),
  };
  assert.deepEqual(await verifyRetainedCatalogWorkers(input), w.guards);
  for (const mutate of [
    (v) => {
      v.inventory[0].State.Running = true;
    },
    (v) => {
      v.inventory[0].State.Pid = 42;
    },
    (v) => {
      v.inventory[0].State.ExitCode = 1;
    },
    (v) => {
      v.inventory[0].Name = "/other";
    },
    (v) => {
      v.inventory[0].HostConfig.Privileged = true;
    },
    (v) => {
      v.guards.delete(w.guards[0].path);
    },
  ]) {
    const v = structuredClone(input);
    mutate(v);
    await assert.rejects(verifyRetainedCatalogWorkers(v));
  }
  const bad = {
    ...w.records["completed.json"],
    authorization: {
      actorId: "1",
      actorLogin: "actor",
      reviewerId: "1",
      reviewerLogin: "actor",
      environmentId: "3",
    },
  };
  await writeFile(join(w.directory, "completed.json"), JSON.stringify(bad) + "\n");
  await assert.rejects(verifyRetainedCatalogWorkers({ ...input, guards: undefined }));
});
