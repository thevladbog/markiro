import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { envBytes, privateFixture } from "./host-fixtures.mjs";

const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const api = (n) => ({
  id: n.toString(16).padStart(64, "0"),
  imageId: `sha256:${"b".repeat(64)}`,
  recipeSha256: n.toString(16).padStart(64, "c"),
});
const authorization = {
  actorId: "1",
  actorLogin: "actor",
  reviewerId: "2",
  reviewerLogin: "reviewer",
  environmentId: "3",
};
export async function chainFixture(t, count = 1, statuses = []) {
  const f = await privateFixture(t, { nested: true });
  const host = dirname(f.root);
  await writeFile(join(host, "guard.json"), "immutable\n", { mode: 0o600 });
  const baseline = {
    acceptedOperationId: randomUUID(),
    api: api(1),
    runtime: { path: f.envFile, sha256: digest(await readFile(f.envFile)) },
  };
  const guardNames = [
    "state/state.json",
    "state/upgrade-index.json",
    `state/forward-recovery-operations/${baseline.acceptedOperationId}/state.json`,
  ];
  await mkdir(join(f.root, "forward-recovery-operations"), { mode: 0o700 });
  await mkdir(join(f.root, "forward-recovery-operations", baseline.acceptedOperationId), {
    mode: 0o700,
  });
  for (const name of guardNames) await writeFile(join(host, name), "immutable\n", { mode: 0o600 });
  await mkdir(join(f.root, "configuration-operations"), { mode: 0o700 });
  const records = [];
  let before = baseline,
    previousOperationId = null,
    previousReceiptSha256 = null;
  for (let index = 0; index < count; index++) {
    const operationId = randomUUID();
    const directory = join(f.root, "configuration-operations", operationId);
    await mkdir(directory, { mode: 0o700 });
    const candidate = join(directory, "runtime.env");
    const bytes = envBytes({ ...f.env, DADATA_TOKEN: `fixture-token-${index}` });
    await writeFile(candidate, bytes, { mode: 0o600 });
    const runtime = { path: candidate, sha256: digest(bytes) };
    const plan = {
      version: 1,
      kind: "platform-dadata-configuration",
      operationId,
      acceptedOperationId: baseline.acceptedOperationId,
      executorSha: "a".repeat(40),
      executorCi: { runId: "4", runAttempt: "1" },
      previousOperationId,
      previousReceiptSha256,
      before,
      runtime,
      containers: { edge: api(100), postgres: api(101) },
      workers: [api(102), api(103)],
      compose: {
        files: [
          join(host, "installed/deploy/platform/compose.yml"),
          join(host, "installed/deploy/platform/compose.compact.yml"),
        ],
        directory: join(host, "installed/deploy/platform"),
        migrationPath: join(f.root, "migration.env"),
        beforeConfigHash: "e".repeat(64),
        afterConfigHash: "f".repeat(64),
      },
      guards: [
        ...["guard.json", ...guardNames].map((path) => ({ path, sha256: digest("immutable\n") })),
        { path: before.runtime.path.slice(host.length + 1), sha256: before.runtime.sha256 },
      ],
      schemaProof: {
        systemId: "42",
        migrationCount: "1",
        schemaSha256: "d".repeat(64),
        migrationSha256: "e".repeat(64),
      },
    };
    const status = statuses[index] ?? "healthy";
    const receipt = {
      version: 1,
      kind: "platform-configuration-successor",
      operationId,
      acceptedOperationId: baseline.acceptedOperationId,
      planSha256: digest(encode(plan)),
      previousOperationId,
      previousReceiptSha256,
      status,
      before: { api: before.api, runtime: before.runtime },
      after: { api: api(index + 2), runtime: status === "healthy" ? runtime : before.runtime },
      dispatch: { toolingSha: plan.executorSha, runId: String(index + 10), runAttempt: "1" },
      authorization: { ...authorization },
    };
    await writeFile(join(directory, "operation.json"), encode(plan), { mode: 0o600 });
    await writeFile(join(directory, "receipt.json"), encode(receipt), { mode: 0o600 });
    previousOperationId = operationId;
    previousReceiptSha256 = digest(encode(receipt));
    before = { acceptedOperationId: baseline.acceptedOperationId, ...receipt.after };
    records.push({ directory, plan, receipt });
  }
  const index = {
    version: 1,
    kind: "platform-configuration-index",
    head: { operationId: previousOperationId, receiptSha256: previousReceiptSha256 },
  };
  const save = async () => {
    for (const record of records) {
      record.receipt.planSha256 = digest(encode(record.plan));
      await writeFile(join(record.directory, "operation.json"), encode(record.plan));
      await writeFile(join(record.directory, "receipt.json"), encode(record.receipt));
    }
    index.head.receiptSha256 = digest(encode(records.at(-1).receipt));
    await writeFile(join(f.root, "config-index.json"), encode(index), { mode: 0o600 });
  };
  await save();
  return { ...f, host, baseline, records, index, save };
}
