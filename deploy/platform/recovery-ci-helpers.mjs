/** Helpers for synthetic disposable CI only; never a production admission. */
import assert from "node:assert/strict";
import { digest } from "./backup/schemas.mjs";
import { ICU_NODE_BASE, ICU_POSTGRES_BASE, workerRecipe } from "./backup/worker-recipes.mjs";
export function validateWorkerManifest(value, sourceSha) {
  assert.equal(value.version, 1);
  assert.equal(value.kind, "platform-recovery-worker");
  assert.equal(value.provenance, "local-synthetic");
  assert.equal(value.sourceSha, sourceSha);
  assert.equal(value.sources.sourceSha, sourceSha);
  assert.equal(value.sources.buildRecipeSha256, digest(workerRecipe("icu")));
  assert.deepEqual(value.sources.baseImages, [ICU_NODE_BASE, ICU_POSTGRES_BASE]);
  assert.match(value.image.id, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(value.image.os, "linux");
  assert.equal(value.image.architecture, "amd64");
  assert.equal(value.archive.name, "recovery-image.tar");
  assert.ok(
    Number.isSafeInteger(value.archive.bytes) &&
      value.archive.bytes > 0 &&
      value.archive.bytes <= 2 * 1024 ** 3,
  );
  assert.match(value.archive.sha256, /^[a-f0-9]{64}$/u);
  return value;
}
export function recoveryRoleMapping(inventory) {
  const references = new Set(inventory.roles.map((v) => v.name));
  for (const object of inventory.objects) {
    references.add(object.owner);
    for (const grant of object.acl) {
      references.add(grant.grantor);
      if (grant.grantee !== "PUBLIC") references.add(grant.grantee);
    }
  }
  return {
    version: 1,
    roles: [...references]
      .sort()
      .map((source) => ({ source, target: source === "postgres" ? "restored_bootstrap" : source })),
    allowedDeltas: inventory.roles.flatMap((role) =>
      ["superuser", "createdb", "createrole", "replication", "bypassrls"]
        .filter((attribute) => role[attribute])
        .map((attribute) => ({
          kind: "role-attribute",
          source: role.name,
          attribute,
          from: true,
          to: false,
        })),
    ),
  };
}
export const recoveryCiLabel = "io.markiro.recovery-ci";
export function captureRecoveryResource(kind, name, value, invocationId) {
  const labels = value.Config?.Labels ?? value.Labels;
  assert.equal(labels?.["com.docker.compose.project"], "markiro-platform");
  assert.equal(labels?.[recoveryCiLabel], invocationId);
  assert.equal(value.Name, kind === "container" ? `/${name}` : name);
  const identity =
    kind === "volume"
      ? {
          name: value.Name,
          createdAt: value.CreatedAt,
          mountpoint: value.Mountpoint,
          driver: value.Driver,
          scope: value.Scope,
          options: value.Options ?? {},
          labels,
        }
      : { id: value.Id, labels };
  if (kind === "volume") {
    assert.ok(typeof identity.createdAt === "string" && identity.createdAt.length > 0);
    assert.ok(typeof identity.mountpoint === "string" && identity.mountpoint.length > 0);
  } else assert.match(identity.id, /^[a-f0-9]{64}$/u);
  return structuredClone({ kind, name, invocationId, identity });
}
export async function removeRecoveryResource(resource, command, invocationId) {
  const { kind, name } = resource;
  assert.equal(resource.invocationId, invocationId);
  const rows = JSON.parse((await command([kind, "inspect", name])).stdout);
  assert.equal(rows.length, 1);
  const actual = captureRecoveryResource(kind, name, rows[0], invocationId);
  assert.deepEqual(actual, resource);
  // Containers/networks are deleted by immutable ID, never by a reusable name.
  await command([
    kind,
    "rm",
    ...(kind === "container" ? ["--force"] : []),
    kind === "volume" ? name : resource.identity.id,
  ]);
  const names = String(
    (
      await command([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        "--format",
        kind === "container" ? "{{.Names}}" : "{{.Name}}",
      ])
    ).stdout,
  )
    .trim()
    .split("\n");
  assert.ok(!names.includes(name));
}
export async function cleanupRecoveryResources(resources, command, invocationId) {
  // Inventory is only a refusal check, never an expanded deletion list.
  for (const kind of ["container", "volume", "network"]) {
    const names = String(
      (
        await command([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          "--filter",
          "label=com.docker.compose.project=markiro-platform",
          "--format",
          kind === "container" ? "{{.Names}}" : "{{.Name}}",
        ])
      ).stdout,
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const name of names)
      assert.ok(
        resources.some((r) => r.kind === kind && r.name === name),
        "Unrecorded same-project resource; cleanup refused",
      );
    for (const resource of resources.filter((r) => r.kind === kind))
      assert.ok(names.includes(resource.name), "Recorded resource disappeared; cleanup refused");
  }
  // Verify the entire set before the first mutation.
  for (const resource of resources) {
    const rows = JSON.parse((await command([resource.kind, "inspect", resource.name])).stdout);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      captureRecoveryResource(resource.kind, resource.name, rows[0], invocationId),
      resource,
    );
  }
  for (const resource of [...resources].reverse())
    await removeRecoveryResource(resource, command, invocationId);
}

// Public CI output must never include a child error message, output or path.
export function recoveryCiErrorCategory(error) {
  if (error?.code === "ERR_TARGET_BACKUP") {
    if (
      [
        "input-validation",
        "host-state",
        "private-inputs",
        "observer-setup",
        "entry-observation",
        "writer-fence",
        "archive-production",
        "isolated-restore",
        "post-restore-observation",
      ].includes(error.targetBackupStage)
    )
      return `target-backup-${error.targetBackupStage}`;
    return "target-backup";
  }
  if (error instanceof TypeError) return "type-error";
  if (error instanceof ReferenceError) return "reference-error";
  if (error instanceof RangeError) return "range-error";
  if (error?.code === "ERR_ASSERTION") return "assertion";
  if (error?.code === "ERR_HOST_PRIVATE_FILE") {
    if (
      [
        "root",
        "path",
        "parent",
        "type",
        "owner",
        "mode",
        "links",
        "opened-dev",
        "opened-ino",
        "opened-size",
        "opened-mtimeNs",
        "opened-ctimeNs",
        "path-dev",
        "path-ino",
        "path-size",
        "path-mtimeNs",
        "path-ctimeNs",
        "read-length",
      ].includes(error.archiveReason)
    )
      return `archive-${error.archiveReason}`;
    return "private-file";
  }
  if (["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC"].includes(error?.code))
    return `filesystem-${error.code}`;
  if (
    error?.code === "ERR_HOST_PROCESS" &&
    ["spawn", "exit", "stdin", "output-limit", "timeout", "aborted", "termination"].includes(
      error.reason,
    )
  )
    return `process-${error.reason}`;
  return "operation";
}
