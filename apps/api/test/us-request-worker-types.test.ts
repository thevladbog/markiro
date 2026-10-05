import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import { assembleUsRequestPackage } from "../src/modules/traceability/requests/us-request-package";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import type { UsRequestFileDescriptor } from "../src/modules/traceability/requests/us-request-package-types";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";

const api = async () => {
  const module = await import("../src/modules/traceability/requests/us-request-worker-types").catch(
    () => null,
  );
  expect(module).not.toBeNull();
  if (!module) throw new Error("Missing worker types");
  return module;
};
const invalid = (operation: () => unknown) =>
  expect(operation).toThrow(
    expect.objectContaining({ response: { code: "us_request_worker_evidence_invalid" } }),
  );
const scope = { tenantId: randomUUID(), runId: randomUUID() };
const lease = {
  ...scope,
  attemptId: randomUUID(),
  attemptNumber: 1,
  cycle: 1,
  token: randomUUID(),
  startedAt: "2026-10-04T00:00:00.000Z",
  expiresAt: "2026-10-04T00:02:00.000Z",
  deadlineAt: "2026-10-04T00:05:00.000Z",
};
it("rejects scope extras, normalization and accessors without evaluating getters", async () => {
  const { parseUsWorkerScope } = await api();
  expect(parseUsWorkerScope(scope)).toEqual(scope);
  for (const value of [
    { ...scope, extra: true },
    { ...scope, tenantId: ` ${scope.tenantId}` },
    { ...scope, runId: scope.runId.toUpperCase() },
  ])
    invalid(() => parseUsWorkerScope(value));
  let touched = false;
  invalid(() =>
    parseUsWorkerScope({
      runId: scope.runId,
      get tenantId() {
        touched = true;
        return scope.tenantId;
      },
    }),
  );
  expect(touched).toBe(false);
});
it("requires safe positive attempts and exact millisecond lease chronology and deadline", async () => {
  const { parseUsWorkerLease } = await api();
  expect(parseUsWorkerLease(lease)).toEqual(lease);
  for (const changes of [
    { attemptNumber: 0 },
    { cycle: 1.5 },
    { expiresAt: lease.startedAt },
    { expiresAt: "2026-10-04T00:06:00.000Z" },
    { startedAt: "2026-10-04T00:00:00.0001Z" },
    { deadlineAt: "2026-10-04T00:05:01.000Z" },
    { token: "secret" },
  ])
    invalid(() => parseUsWorkerLease({ ...lease, ...changes }));
});
it("binds object UUID paths, fixed media/kind/size mappings and safe bigint conversion", async () => {
  const { parseUsWorkerObjectEvidence, usWorkerByteSizeFromDb } = await api();
  const evidence = {
    ...scope,
    id: randomUUID(),
    attemptId: lease.attemptId,
    name: "manifest.json",
    kind: "manifest",
    objectKey: `us/requests/${scope.tenantId}/${scope.runId}/${lease.attemptId}/manifest.json`,
    mediaType: "application/json",
    byteSize: 10,
    sha256: "a".repeat(64),
  };
  expect(parseUsWorkerObjectEvidence(evidence)).toEqual(evidence);
  for (const changes of [
    { name: "SHA256SUMS" },
    { kind: "xlsx" },
    { mediaType: "text/plain" },
    { byteSize: 0 },
    { byteSize: 1048577 },
    { objectKey: "us/plans/original.pdf" },
    { sha256: "A".repeat(64) },
  ])
    invalid(() => parseUsWorkerObjectEvidence({ ...evidence, ...changes }));
  expect(usWorkerByteSizeFromDb(10n)).toBe(10);
  for (const value of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, -1n, 1.5, "10"])
    invalid(() => usWorkerByteSizeFromDb(value));
});

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("worker checkpoint/expectation parsers with real package evidence", () => {
  let db: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  let inputs: ReturnType<typeof bindUsRequestPackageInputs>;
  let packageResult: Awaited<ReturnType<typeof assembleUsRequestPackage>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US URL");
    db = await createUsProfileTestDatabase(url);
    fixture = await createUsRequestPackageFixture(db.db, { mode: "export_ready" });
    inputs = bindUsRequestPackageInputs(
      fixture.run,
      fixture.tenantId,
      fixture.payloads,
      fixture.plan,
      fixture.context,
    );
    packageResult = await assembleUsRequestPackage(inputs);
  }, 60_000);
  afterAll(async () => {
    fixture?.destroy();
    await db?.close();
  });
  it("uses actual model validation/digest binding and returns defensive model copies", async () => {
    const { parseUsWorkerCheckpoint } = await api();
    const value = {
      model: inputs.model,
      modelDigest: createHash("sha256").update(stableStringify(inputs.model)).digest("hex"),
      executionDigest: "a".repeat(64),
      packageVersion: "us-request-package-v1",
      reportVersion: "us-request-report-pdf-v1",
    };
    const copied = parseUsWorkerCheckpoint(value);
    expect(copied.model).toEqual(inputs.model);
    expect(copied.model).not.toBe(inputs.model);
    for (const changes of [
      { modelDigest: "b".repeat(64) },
      { model: { ...inputs.model, unexpected: true } },
      { reportVersion: "unknown" },
      {
        model: {
          ...inputs.model,
          timing: { ...inputs.model.timing, reportDataPreparedAt: "2026-10-04T00:00:00.0001Z" },
        },
      },
    ])
      invalid(() => parseUsWorkerCheckpoint({ ...value, ...changes }));
    const file = inputs.preReportFiles[0];
    if (!file) throw new Error("Missing bytes");
    const original = Buffer.from(file.bytes);
    const savedDigest = copied.model.preReportFiles[0]?.sha256;
    file.bytes.fill(0);
    expect(copied.model.preReportFiles[0]?.sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    const modelFile = inputs.model.preReportFiles[0];
    if (!modelFile) throw new Error("Missing model descriptor");
    const previous = modelFile.sha256;
    modelFile.sha256 = "b".repeat(64);
    expect(copied.model.preReportFiles[0]?.sha256).toBe(savedDigest);
    modelFile.sha256 = previous;
    file.bytes.set(original);
  });
  it("uses actual manifest validator and rejects missing, mismatched or extra package descriptors", async () => {
    const { parseUsWorkerPackageExpectation } = await api();
    const descriptor = ({ name, mediaType, byteSize, sha256 }: UsRequestFileDescriptor) => ({
      name,
      mediaType,
      byteSize,
      sha256,
    });
    const value = {
      manifest: packageResult.manifest,
      entries: packageResult.files.map(descriptor),
      zip: descriptor(packageResult.zip),
    };
    expect(parseUsWorkerPackageExpectation(value)).toEqual(value);
    for (const changes of [
      { entries: value.entries.slice(1) },
      { manifest: { ...value.manifest, unexpected: true } },
      { zip: { ...value.zip, name: "manifest.json" } },
      {
        entries: value.entries.map((e) =>
          e.name === "validation.json" ? { ...e, sha256: "b".repeat(64) } : e,
        ),
      },
    ])
      invalid(() => parseUsWorkerPackageExpectation({ ...value, ...changes }));
    const copy = parseUsWorkerPackageExpectation(value);
    const first = value.entries[0];
    if (!first) throw new Error("Missing descriptor");
    const old = first.sha256;
    first.sha256 = "b".repeat(64);
    expect(copy.entries[0]?.sha256).toBe(old);
    first.sha256 = old;
  });
});
