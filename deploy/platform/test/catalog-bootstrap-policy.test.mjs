import test from "node:test";
import assert from "node:assert/strict";
import { validateReadBootstrapOperation, workerEnvironment } from "../catalog-bootstrap-policy.mjs";
export function operation() {
  const sha = "a".repeat(64),
    id = "de7a478d-e712-45bb-b36f-40067a62ab1d";
  return {
    schema: 1,
    kind: "catalog-read-bootstrap",
    operationId: id,
    catalogOperationId: id,
    executorSha: "b".repeat(40),
    executorCi: { runId: "123", runAttempt: "1" },
    productSourceSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53",
    artifact: { id: "456", zipSha256: sha },
    inputFileSha256: sha,
    bootstrapModuleSha256: sha,
    runtimeScriptSha256: sha,
    binding: {
      operationId: id,
      epoch: id,
      evidenceSha256: sha,
      identity: { product: "standalone", channel: "stable" },
      targetVersion: "1.1.1",
    },
    acceptedOperationId: id,
    guards: [
      "state/state.json",
      "state/backup-runtime.json",
      "state/upgrade-index.json",
      `state/forward-recovery-operations/${id}/state.json`,
      "state/candidates/b793db93-0e6b-4b1c-bb5e-5afc3a16230a/runtime.env",
    ].map((path) => ({ path, sha256: sha })),
    containers: Object.fromEntries(
      ["api", "edge", "postgres"].map((name, i) => [
        name,
        { id: String(i + 1).repeat(64), imageId: `sha256:${sha}`, recipeSha256: sha },
      ]),
    ),
    networkId: "c".repeat(64),
    egressNetworkId: "d".repeat(64),
    postgresCaSha256: sha,
    schemaProof: {
      systemId: "7698396358009868314",
      migrationCount: "202",
      schemaSha256: sha,
      migrationSha256: sha,
    },
  };
}
test("strict bootstrap plan has no writer enablement or operation expiry and requires all critical retained guards", () => {
  assert.deepEqual(validateReadBootstrapOperation(operation()), operation());
  for (const change of [
    (o) => (o.expiresAt = "2026-10-29T00:00:00Z"),
    (o) => (o.binding.identity.product = "station"),
    (o) => (o.binding.operationId = "other"),
    (o) => (o.executorCi.runAttempt = "2"),
    (o) => o.guards.pop(),
    (o) => (o.guards[0].path = "../state.json"),
    (o) => o.guards.push({ path: "state/github-token", sha256: "a".repeat(64) }),
    (o) => (o.containers.edge.id = o.containers.api.id),
    (o) => delete o.egressNetworkId,
    (o) => (o.egressNetworkId = o.networkId),
  ]) {
    const input = operation();
    change(input);
    assert.throws(() => validateReadBootstrapOperation(input));
  }
});
test("worker gets only DB connection and read-only catalog configuration, never unrelated production keys", () => {
  const env = [
    "DATABASE_URL=postgres://private",
    "SERVER_PROFILE=platform-only",
    "RELEASE_CATALOG_WRITERS_ENABLED=false",
    "RELEASE_CATALOG_S3_SECRET_ACCESS_KEY=private",
    "LICENSE_SIGNING_KEY=do-not-copy",
    "CHZ_TOKEN_ENCRYPTION_KEY=do-not-copy",
  ];
  assert.deepEqual(workerEnvironment(env), env.slice(0, 4));
  assert.throws(() =>
    workerEnvironment(env.map((s) => s.replace("ENABLED=false", "ENABLED=true"))),
  );
  assert.throws(() => workerEnvironment([...env, "DATABASE_URL=other"]));
});
