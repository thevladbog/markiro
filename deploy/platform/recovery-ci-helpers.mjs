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
export async function cleanupRecoveryResources(resources, command) {
  for (const [kind, name] of [...resources].reverse()) {
    const rows = JSON.parse((await command([kind, "inspect", name])).stdout);
    assert.equal(rows.length, 1);
    assert.equal(
      (rows[0].Config?.Labels ?? rows[0].Labels)?.["com.docker.compose.project"],
      "markiro-platform",
    );
    await command([kind, "rm", ...(kind === "container" ? ["--force"] : []), name]);
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
}
