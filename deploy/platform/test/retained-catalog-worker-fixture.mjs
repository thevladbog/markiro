import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../backup/schemas.mjs";
import { containerRecipe } from "../host/container-recipe.mjs";

export async function retainedCatalogWorkerFixture(
  host,
  acceptedOperationId,
  digit = "7",
  image = `sha256:${"a".repeat(64)}`,
) {
  const operationId = randomUUID(),
    id = digit.repeat(64),
    imageId = image;
  const worker = {
    Id: id,
    Name: `/markiro-catalog-bootstrap-${operationId}`,
    Image: imageId,
    Config: {
      Image: `ghcr.io/thevladbog/markiro-api@${imageId}`,
      User: "1000:1000",
      Labels: { "markiro.catalog-bootstrap": operationId },
    },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"] },
    Mounts: [
      {
        Source: `${host}/release-catalog/cache`,
        Destination: `${host}/release-catalog/cache`,
        Type: "bind",
        RW: true,
      },
      {
        Source: `${host}/release-catalog/journal`,
        Destination: `${host}/release-catalog/journal`,
        Type: "bind",
        RW: true,
      },
    ],
    State: {
      Status: "exited",
      Running: false,
      Pid: 0,
      ExitCode: 0,
      OOMKilled: false,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    NetworkSettings: { Networks: {} },
  };
  const operation = {
    schema: 1,
    kind: "catalog-read-bootstrap",
    operationId,
    acceptedOperationId,
    executorSha: "b".repeat(40),
    containers: { api: { imageId } },
  };
  const bytes = Buffer.from(JSON.stringify(operation) + "\n"),
    directory = join(host, "catalog-bootstrap-operations", operationId);
  await mkdir(join(host, "catalog-bootstrap-operations"), { mode: 0o700, recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const completed = {
    schema: 1,
    operationId,
    planSha256: digest(bytes),
    dispatch: { toolingSha: operation.executorSha, runId: "123", runAttempt: "1" },
    authorization: {
      actorId: "1",
      actorLogin: "actor",
      reviewerId: "2",
      reviewerLogin: "reviewer",
      environmentId: "3",
    },
    phase: "completed",
    observedAt: "2026-10-30T09:30:00.000Z",
  };
  const records = {
    "operation.json": operation,
    "completed.json": completed,
    "worker-created.json": { id, operationId },
    "worker-terminal.json": {
      id,
      exitCode: 0,
      oomKilled: false,
      result: { revision: "1", readable: true, writersMayEnable: false },
    },
  };
  const guards = [];
  for (const [name, value] of Object.entries(records)) {
    const raw = Buffer.from(JSON.stringify(value) + "\n");
    await writeFile(join(directory, name), raw, { mode: 0o600 });
    guards.push({
      path: `catalog-bootstrap-operations/${operationId}/${name}`,
      sha256: digest(raw),
    });
  }
  return {
    worker,
    expected: { id, imageId, recipeSha256: containerRecipe(worker) },
    guards,
    directory,
    records,
  };
}
