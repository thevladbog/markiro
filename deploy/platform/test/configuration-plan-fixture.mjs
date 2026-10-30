export const configurationPlanFixture = () => {
  const hash = (c) => c.repeat(64);
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const acceptedOperationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const runtime =
    "/private/tmp/markiro-test/state/candidates/cccccccc-cccc-4ccc-8ccc-cccccccccccc/runtime.env";
  const container = (c) => ({
    id: hash(c),
    imageId: `sha256:${hash("d")}`,
    recipeSha256: hash("e"),
  });
  return {
    version: 1,
    kind: "platform-dadata-configuration",
    operationId,
    acceptedOperationId,
    executorSha: "f".repeat(40),
    executorCi: { runId: "123", runAttempt: "1" },
    previousOperationId: null,
    previousReceiptSha256: null,
    before: {
      acceptedOperationId,
      api: container("1"),
      runtime: { path: runtime, sha256: hash("2") },
    },
    runtime: {
      path: `/private/tmp/markiro-test/state/configuration-operations/${operationId}/runtime.env`,
      sha256: hash("3"),
    },
    containers: { edge: container("4"), postgres: container("5") },
    workers: [],
    compose: {
      directory: "/private/tmp/markiro-test/bundle/deploy/platform",
      files: [
        "/private/tmp/markiro-test/bundle/deploy/platform/compose.yml",
        "/private/tmp/markiro-test/bundle/deploy/platform/compose.compact.yml",
        "/private/tmp/markiro-test/bundle/deploy/platform/compose.catalog.yml",
      ],
      migrationPath: runtime.replace("runtime.env", "migration.env"),
      beforeConfigHash: hash("6"),
      afterConfigHash: hash("7"),
    },
    guards: [
      { path: "state/state.json", sha256: hash("8") },
      { path: "state/upgrade-index.json", sha256: hash("9") },
      {
        path: `state/forward-recovery-operations/${acceptedOperationId}/state.json`,
        sha256: hash("a"),
      },
      { path: runtime.slice("/private/tmp/markiro-test/".length), sha256: hash("2") },
    ],
    schemaProof: {
      systemId: "123",
      migrationCount: "202",
      schemaSha256: hash("b"),
      migrationSha256: hash("c"),
    },
  };
};
