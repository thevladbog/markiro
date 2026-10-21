import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertUsDatasetCommandPreflight,
  runUsDatasetCommand,
  usDatasetCommandDiagnostic,
} from "../src/deployment/us-dataset-command-runtime";
import { createDb } from "@markiro/db";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import {
  annotateUsDatasetRequestFailure,
  equalRequest,
  requestError,
} from "../src/modules/traceability/demo/us-dataset-request-contract";
import { UsRequestWorkerCheckpoints } from "../src/modules/traceability/requests/us-request-worker-checkpoint";
import type { UsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-types";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";

const args = [
  "verify",
  "--database-name",
  "markiro_us_dev",
  "--database-user",
  "markiro_us",
  "--tenant-id",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "--owner-id",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "--version",
  "us-processor-six-month-v1",
  "--definition-digest",
  "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
];
const storage = {
  US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
  US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-dataset-plans",
  US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-plan-access",
  US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-plan-secret",
  US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_REQUEST_PACKAGE_S3_REGION: "us-east-1",
  US_REQUEST_PACKAGE_S3_BUCKET: "synthetic-dataset-packages",
  US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID: "synthetic-package-access",
  US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "synthetic-package-secret",
  US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE: "true",
};

// Canonical empty codec data from us-request-package-zip.test.ts; not dataset/Ready proof.
function checkpointRefusalFixture() {
  const bytes = Buffer.from('{"fixture":1}');
  const validation = {
    name: "validation.json" as const,
    mediaType: "application/json",
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const inputs: UsRequestPackageInputs = {
    model: {
      schemaVersion: 1,
      identity: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        requestId: "11111111-1111-4111-8111-111111111111",
        requestRevision: 1,
        runId: "22222222-2222-4222-8222-222222222222",
        runRevision: 1,
        mode: "available_records_incomplete",
        preparedBy: "codec-fixture-actor",
      },
      request: {
        id: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        requestNumber: "CODEC-EMPTY",
        requesterName: "Synthetic codec",
        requesterOrganization: null,
        requesterContact: "private@example.test",
        receivedAt: "2026-10-04T00:00:00Z",
        dueAt: "2026-10-05T00:00:00Z",
        alternateDeadlineReason: null,
      },
      scope: { tlcs: ["EMPTY-CODEC"] },
      timing: {
        schemaVersion: 1,
        preparationStartedAt: "2026-10-04T00:00:00.000Z",
        workerStartedAt: null,
        reportDataPreparedAt: "2026-10-04T00:00:02.000Z",
        elapsedToReportDataPreparationMs: 2000,
      },
      tenantOrigin: {
        schemaVersion: 1,
        verificationPolicy: "us-request-tenant-origin-v1",
        result: "not_attested",
        trustedSeed: null,
      },
      stamps: {
        profile: "US_FSMA204_PROCESSOR",
        timeZone: "America/New_York",
        baselineId: "codec-fixture-baseline",
        registryId: "fda_sortable_xlsx",
        registryVersion: 1,
        registryHash: "a".repeat(64),
        build: { apiVersion: "codec-fixture", gitSha: "a".repeat(40), dirty: false },
      },
      selectionSummary: {
        capturedRevisionCount: 0,
        workbookEventCount: 0,
        byType: { receiving: 0, transformation: 0, shipping: 0 },
        byLifecycle: { current_finalized: 0, historical_finalized: 0, draft: 0, void: 0 },
      },
      findingsSummary: {
        validation: { error: 0, warning: 0, info: 0 },
        render: { error: 0, warning: 0, info: 0 },
      },
      renderFindings: [],
      warningAcknowledgement: null,
      plan: null,
      digests: { scopedContentDigest: "b".repeat(64), inputDigest: null },
      preReportFiles: [validation],
      missingFiles: [
        { name: "records.xlsx", code: "empty_selection" },
        { name: "plan.pdf", code: "plan_absent" },
      ],
    },
    preReportFiles: [{ ...validation, bytes }],
  };
  const checkpoint = {
    model: structuredClone(inputs.model),
    modelDigest: createHash("sha256").update(stableStringify(inputs.model)).digest("hex"),
    executionDigest: "e".repeat(64),
    packageVersion: "us-request-package-v1",
    reportVersion: "us-request-report-pdf-v1",
  };
  const check = () =>
    UsRequestWorkerCheckpoints.prototype.assertReproduction(checkpoint, inputs, "e".repeat(64));
  expect(check).not.toThrow();
  return { inputs, check };
}
function actualRefusal(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected actual refusal predicate to throw");
}
const requestFailureLocation = { unitKey: "request_september", stage: "package" } as const;

describe("finite Request failure propagation", () => {
  it("retains actual checkpoint model-drift code and trusted Request location", () => {
    const { inputs, check } = checkpointRefusalFixture();
    inputs.model.request.requesterName = "Changed canonical model";
    const error = actualRefusal(check);
    expect(error).toBeInstanceOf(ConflictException);
    expect(annotateUsDatasetRequestFailure(error, requestFailureLocation)).toBe(error);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_request_worker_checkpoint_mismatch",
      unitKey: "request_september",
      stage: "package",
    });
  });
  it("retains actual unchanged-descriptor changed-byte checkpoint refusal", () => {
    const { inputs, check } = checkpointRefusalFixture();
    const file = inputs.preReportFiles[0];
    if (!file) throw new Error("Missing codec validation bytes");
    file.bytes.fill(0);
    const error = actualRefusal(check);
    expect(error).toBeInstanceOf(ConflictException);
    expect(annotateUsDatasetRequestFailure(error, requestFailureLocation)).toBe(error);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_request_worker_checkpoint_mismatch",
      unitKey: "request_september",
      stage: "package",
    });
  });
  it("retains actual descriptor inequality code and trusted Request location", () => {
    const error = actualRefusal(() =>
      equalRequest({ sha256: "a".repeat(64) }, { sha256: "b".repeat(64) }),
    );
    expect(annotateUsDatasetRequestFailure(error, requestFailureLocation)).toBe(error);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_request_conflict",
      unitKey: "request_september",
      stage: "package",
    });
  });
  it("retains finite Request incomplete at its trusted request boundary", () => {
    const error = requestError("incomplete");
    expect(
      annotateUsDatasetRequestFailure(error, { unitKey: "request_april", stage: "request" }),
    ).toBe(error);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_request_incomplete",
      unitKey: "request_april",
      stage: "request",
    });
  });
  it("keeps hostile and unknown metadata private and existing command categories dominant", () => {
    let touched = 0;
    const getter = {
      get: () => {
        touched++;
        throw new Error("private accessor");
      },
    };
    const inherited = Object.setPrototypeOf({}, { code: "us_request_worker_checkpoint_mismatch" });
    for (const error of [
      new Error("SELECT credential postgres://private.invalid"),
      new Error("us_request_worker_deadline_exceeded"),
      {
        message: "unknown",
        response: { code: "us_request_package_storage_checksum_mismatch", private: "raw-secret" },
      },
      { message: "unknown", response: inherited },
      Object.defineProperty({}, "response", getter),
      { response: Object.defineProperty({}, "code", getter) },
      Object.defineProperty({}, "message", getter),
      Object.setPrototypeOf({}, { message: "us_dataset_request_conflict" }),
      Object.assign(new Error("unknown"), { unitKey: "request_september", stage: "shipping" }),
    ])
      expect(usDatasetCommandDiagnostic(error)).toEqual({ code: "us_dataset_command_failed" });
    for (const code of [
      "us_dataset_command_schema_invalid",
      "us_dataset_command_disposal_failed",
    ]) {
      const error = Object.assign(new Error(code), {
        response: { code: "us_request_worker_checkpoint_mismatch" },
      });
      expect(usDatasetCommandDiagnostic(error)).toEqual({ code });
      const opaqueResponse = new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            touched++;
            throw new Error("private response trap");
          },
        },
      );
      expect(
        usDatasetCommandDiagnostic(Object.assign(new Error(code), { response: opaqueResponse })),
      ).toEqual({ code });
    }
    const known = new ConflictException({
      code: "us_dataset_request_conflict",
      private: "raw-secret",
    });
    expect(usDatasetCommandDiagnostic(known)).toEqual({ code: "us_dataset_request_conflict" });
    const wrongLocation = Object.assign(requestError("incomplete"), {
      unitKey: "chain_0260",
      stage: "package",
    });
    expect(usDatasetCommandDiagnostic(wrongLocation)).toEqual({
      code: "us_dataset_request_incomplete",
    });
    const opaqueResponse = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("private response trap");
        },
      },
    );
    expect(
      usDatasetCommandDiagnostic(
        Object.assign(new Error("unknown"), {
          response: opaqueResponse,
          unitKey: "chain_0259",
          stage: "shipping",
        }),
      ),
    ).toEqual({ code: "us_dataset_command_failed", unitKey: "chain_0259", stage: "shipping" });
    expect(touched).toBe(0);
  });
  it("preserves original identity, frozen and unsafe metadata and valid lower canonical locations", () => {
    let touched = 0;
    const cause = new Error("original private cause");
    const error = new ConflictException(
      { code: "us_request_worker_checkpoint_mismatch" },
      { cause },
    );
    expect(annotateUsDatasetRequestFailure(error, requestFailureLocation)).toBe(error);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.cause).toBe(cause);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_request_worker_checkpoint_mismatch",
      unitKey: "request_september",
      stage: "package",
    });
    for (const root of [
      Object.assign(requestError("conflict"), { unitKey: "chain_0259", stage: "shipping" }),
      new Error("wrapper", {
        cause: Object.assign(requestError("conflict"), {
          unitKey: "orphan_0001",
          stage: "void_receiving",
        }),
      }),
    ]) {
      const before = Object.getOwnPropertyDescriptors(root);
      const diagnostic = usDatasetCommandDiagnostic(root);
      expect(annotateUsDatasetRequestFailure(root, requestFailureLocation)).toBe(root);
      expect(Object.getOwnPropertyDescriptors(root)).toEqual(before);
      expect(usDatasetCommandDiagnostic(root)).toEqual(diagnostic);
    }
    const unsafe = Object.defineProperty(new Error("private"), "unitKey", {
      get: () => {
        touched++;
        return "private";
      },
    });
    const unsafeCause = Object.defineProperty(new Error("private"), "cause", {
      get: () => {
        touched++;
        return cause;
      },
    });
    const inheritedLocation = Object.setPrototypeOf(
      new Error("private"),
      Object.assign(new Error("prototype"), { unitKey: "private", stage: "private" }),
    );
    const cyclic = new Error("private");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    let deep: Error = new Error("private");
    for (let depth = 0; depth < 32; depth++) deep = new Error("wrapper", { cause: deep });
    const opaque = new Proxy(new Error("private"), {
      defineProperty: () => {
        touched++;
        throw new Error("private error trap");
      },
    });
    const frozen = Object.freeze(requestError("incomplete"));
    for (const root of [
      frozen,
      unsafe,
      unsafeCause,
      inheritedLocation,
      cyclic,
      deep,
      opaque,
      { private: true },
      null,
      "private",
    ]) {
      const before =
        root && typeof root === "object" ? Object.getOwnPropertyDescriptors(root) : undefined;
      expect(annotateUsDatasetRequestFailure(root, requestFailureLocation)).toBe(root);
      if (before) expect(Object.getOwnPropertyDescriptors(root)).toEqual(before);
    }
    for (const trap of ["has", "getPrototypeOf"] as const) {
      const original = new Error("original operational failure");
      let trapCalls = 0;
      const prototype = {};
      Object.setPrototypeOf(prototype, Error.prototype);
      Object.setPrototypeOf(
        original,
        new Proxy(
          prototype,
          trap === "has"
            ? {
                has: (target, key) => {
                  trapCalls++;
                  original.message = "changed by inherited has trap";
                  return Reflect.has(target, key);
                },
              }
            : {
                getPrototypeOf: (target) => {
                  trapCalls++;
                  original.message = "changed by inherited getPrototypeOf trap";
                  return Reflect.getPrototypeOf(target);
                },
              },
        ),
      );
      const before = Object.getOwnPropertyDescriptors(original);
      const result = annotateUsDatasetRequestFailure(original, requestFailureLocation);
      expect.soft(result).toBe(original);
      expect.soft(trapCalls, trap).toBe(0);
      expect.soft(original.message, trap).toBe("original operational failure");
      expect.soft(Object.getOwnPropertyDescriptors(original), trap).toEqual(before);
      expect.soft(Object.hasOwn(original, "unitKey"), trap).toBe(false);
      expect.soft(Object.hasOwn(original, "stage"), trap).toBe(false);
    }
    const absent = new Error("private");
    expect(annotateUsDatasetRequestFailure(absent, undefined)).toBe(absent);
    expect(Object.hasOwn(absent, "unitKey")).toBe(false);
    const locationAccessor = {
      get unitKey() {
        touched++;
        return "request_september" as const;
      },
      stage: "package" as const,
    };
    expect(annotateUsDatasetRequestFailure(absent, locationAccessor)).toBe(absent);
    expect(Object.hasOwn(absent, "unitKey")).toBe(false);
    for (const location of [
      Object.defineProperty({ ...requestFailureLocation }, "unitKey", { value: "chain_0259" }),
      Object.defineProperty({ ...requestFailureLocation }, "stage", { value: "shipping" }),
      { ...requestFailureLocation, untrusted: true },
    ]) {
      expect(annotateUsDatasetRequestFailure(absent, location)).toBe(absent);
      expect(Object.hasOwn(absent, "unitKey")).toBe(false);
    }
    expect(usDatasetCommandDiagnostic(frozen)).toEqual({ code: "us_dataset_request_incomplete" });
    expect(touched).toBe(0);
  });
});

describe("dataset executable policy and private diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { argv: [...args, "--reset"], override: {}, code: "us_dataset_command_arguments_invalid" },
    {
      argv: args,
      override: { NODE_ENV: "production" },
      code: "us_dataset_command_environment_invalid",
    },
    {
      argv: args,
      override: { US_REQUEST_PACKAGE_S3_BUCKET: "" },
      code: "us_dataset_command_storage_unavailable",
    },
    {
      argv: args,
      override: { DATABASE_URL: "postgres://bad:raw-secret@remote.invalid:55432/markiro_us_dev" },
      code: "us_dataset_command_environment_invalid",
    },
  ])("refuses $code before any external resource is acquired", async ({ argv, override, code }) => {
    const connection = vi.spyOn(await import("@markiro/db"), "createDb");
    const provider = vi.spyOn(S3Client.prototype, "send");
    await expect(
      runUsDatasetCommand(argv, { ...(await localBuildEnv()), ...storage, ...override }),
    ).rejects.toThrow(code);
    expect(connection).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("prints only a fixed category for unknown provider/SQL failures", () => {
    const error = Object.assign(new Error("SELECT raw-secret postgres://private.invalid"), {
      code: "arbitrary-provider-code",
      unitKey: "https://raw-secret",
      stage: "SQL raw-secret",
    });
    expect(usDatasetCommandDiagnostic(error)).toEqual({ code: "us_dataset_command_failed" });
  });

  it("does not execute hostile diagnostic getters", () => {
    const hostile = Object.defineProperty({}, "message", {
      get: () => {
        throw new Error("raw-secret");
      },
    });
    expect(usDatasetCommandDiagnostic(hostile)).toEqual({ code: "us_dataset_command_failed" });
  });

  it("exposes only a valid recipe unit and that unit's allowed stage", () => {
    const failure = Object.assign(new Error("us_dataset_native_drift"), {
      unitKey: "chain_0259",
      stage: "shipping",
    });
    expect(usDatasetCommandDiagnostic(failure)).toEqual({
      code: "us_dataset_command_failed",
      unitKey: "chain_0259",
      stage: "shipping",
    });
    expect(
      usDatasetCommandDiagnostic(
        Object.assign(new Error("raw-secret"), { unitKey: "chain_0260", stage: "shipping" }),
      ),
    ).toEqual({ code: "us_dataset_command_failed" });
    expect(
      usDatasetCommandDiagnostic(
        Object.assign(new Error("raw-secret"), { unitKey: "orphan_0001", stage: "shipping" }),
      ),
    ).toEqual({ code: "us_dataset_command_failed" });
  });

  it("retains a fixed category and valid original stage through internal wrapping", () => {
    const cause = Object.assign(new Error("provider raw-secret"), {
      unitKey: "request_september",
      stage: "package",
    });
    const error = new Error("us_dataset_command_connection_failed", { cause });
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_command_connection_failed",
      unitKey: "request_september",
      stage: "package",
    });
  });

  it("bounds cyclic cause traversal and drops mismatched stages", () => {
    const error = Object.assign(new Error("provider raw-secret"), {
      unitKey: "plan",
      stage: "package",
    });
    Object.defineProperty(error, "cause", { value: error });
    expect(usDatasetCommandDiagnostic(error)).toEqual({ code: "us_dataset_command_failed" });
  });
});

type Connection = ReturnType<typeof createDb>;
type ClientConstructor = NonNullable<Connection["pool"]["options"]["Client"]>;
function clientConstructor(value: unknown): value is ClientConstructor {
  if (typeof value !== "function") return false;
  const prototype: unknown = Object.getOwnPropertyDescriptor(value, "prototype")?.value;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    "query" in prototype &&
    "connect" in prototype
  );
}
const context: UsDatasetContext = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  actorUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedDatabaseName: "markiro_us_dev",
  expectedDatabaseUser: "markiro_us",
};
function ownerFacts() {
  return {
    codec: "us-development-owner-provenance-v1",
    organization: {
      id: context.tenantId,
      name: "Synthetic US development",
      metadata: '{"synthetic":true,"seedVersion":"us-development-owner-v1"}',
    },
    user: { id: context.actorUserId, name: "Synthetic US development owner" },
    memberships: { count: 1, soleRole: "owner" },
    credentials: { count: 1, soleAccountId: context.actorUserId, nonemptyPassword: true },
    audits: {
      count: 1,
      sole: {
        actorUserId: context.actorUserId,
        outcome: "success",
        targetType: "tenant",
        targetId: context.tenantId,
        before: null,
        after: { synthetic: true, seedVersion: "us-development-owner-v1" },
      },
    },
  };
}
function databaseBoundary() {
  const connection = createDb("postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev");
  const constructor: unknown = Object.getOwnPropertyDescriptor(connection.pool, "Client")?.value;
  if (!clientConstructor(constructor)) throw new Error("Missing actual pg client constructor");
  const client = Object.assign(new constructor(), { release: vi.fn() });
  const queries: string[] = [];
  const state: {
    name: string;
    user: string;
    owner: unknown;
    profile: Record<string, unknown> | undefined;
    before: ((text: string) => Promise<void>) | undefined;
  } = {
    name: "markiro_us_dev",
    user: "markiro_us",
    owner: ownerFacts(),
    profile: {
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      timeZone: "America/Los_Angeles",
    },
    before: undefined,
  };
  vi.spyOn(client, "query").mockImplementation(async (query: unknown) => {
    const text: unknown =
      typeof query === "string"
        ? query
        : query && typeof query === "object"
          ? Object.getOwnPropertyDescriptor(query, "text")?.value
          : undefined;
    if (typeof text !== "string") throw new Error("Unexpected database boundary query");
    queries.push(text);
    await state.before?.(text);
    let rows: unknown[] = [];
    if (text.includes("current_database()")) rows = [{ name: state.name, owner: state.user }];
    else if (text.includes("us_development_owner_provenance_v1")) rows = [{ facts: state.owner }];
    else if (/select "role" from "member"/.test(text)) rows = [["owner"]];
    else if (text.includes("WITH locked_profile")) rows = state.profile ? [state.profile] : [];
    return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
  });
  vi.spyOn(connection.pool, "connect").mockImplementation(async () => client);
  return { connection, queries, state, client };
}

describe("actual dataset prerequisite queries at the pg transport boundary", () => {
  let boundary: ReturnType<typeof databaseBoundary> | undefined;
  afterEach(async () => {
    await boundary?.connection.pool.end();
    vi.restoreAllMocks();
    boundary = undefined;
  });
  it.each([
    { name: "markiro_us_dev_child", user: "markiro_us" },
    { name: "markiro_us_dev", user: "wrong_user" },
  ])(
    "refuses actual target $name / $user before schema/provenance work",
    async ({ name, user }) => {
      boundary = databaseBoundary();
      Object.assign(boundary.state, { name, user });
      await expect(
        assertUsDatasetCommandPreflight(boundary.connection.db, context),
      ).rejects.toThrow("us_dataset_command_target_invalid");
      expect(
        boundary.queries.some(
          (text) => text.includes("us_development_owner_provenance_v1") || text.includes("limit $"),
        ),
      ).toBe(false);
    },
  );
  it("fails closed on outdated required schema without reading provenance or writing", async () => {
    boundary = databaseBoundary();
    boundary.state.before = async (text) => {
      if (text.includes('from "trace_export_object_intents"'))
        throw new Error("SQL secret missing column");
    };
    await expect(assertUsDatasetCommandPreflight(boundary.connection.db, context)).rejects.toThrow(
      "us_dataset_command_schema_invalid",
    );
    expect(
      boundary.queries.some((text) => text.includes("us_development_owner_provenance_v1")),
    ).toBe(false);
    expect(
      boundary.queries.some((text) => /^(insert|update|delete|alter|create)/i.test(text)),
    ).toBe(false);
  });
  it.each([
    "missing owner",
    "different actor",
    "missing profile",
    "wrong profile",
    "wrong timezone",
  ])("refuses %s before seeding", async (kind) => {
    boundary = databaseBoundary();
    if (kind === "missing owner") boundary.state.owner = null;
    if (kind === "different actor")
      boundary.state.owner = {
        ...ownerFacts(),
        user: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: "Synthetic US development owner",
        },
      };
    if (kind === "missing profile") boundary.state.profile = undefined;
    if (kind === "wrong profile")
      boundary.state.profile = { ...boundary.state.profile, code: "US_FSMA204_DISTRIBUTOR" };
    if (kind === "wrong timezone")
      boundary.state.profile = { ...boundary.state.profile, timeZone: "UTC" };
    await expect(assertUsDatasetCommandPreflight(boundary.connection.db, context)).rejects.toThrow(
      "us_dataset_command_prerequisite_invalid",
    );
    expect(
      boundary.queries.some((text) => /^(insert|update|delete|alter|create)/i.test(text)),
    ).toBe(false);
  });
  it("uses actual original-owner/profile locks in a compatible no-business-write transaction", async () => {
    boundary = databaseBoundary();
    await expect(
      assertUsDatasetCommandPreflight(boundary.connection.db, context),
    ).resolves.toBeUndefined();
    expect(boundary.queries[0]).toMatch(/^begin isolation level repeatable read$/);
    expect(
      boundary.queries.some((text) => text.includes("us_development_owner_provenance_v1")),
    ).toBe(true);
    expect(boundary.queries.some((text) => text.includes("FOR SHARE"))).toBe(true);
    expect(
      boundary.queries.some((text) => /read only|^(insert|update|delete|alter|create)/i.test(text)),
    ).toBe(false);
    expect(boundary.queries.at(-1)).toBe("commit");
    expect(boundary.client.release).toHaveBeenCalledTimes(1);
  });
});

describe("checked dataset command resource lifetime", () => {
  let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
  let boundary: ReturnType<typeof databaseBoundary> | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (boundary && !boundary.connection.pool.ended) await boundary.connection.pool.end();
    await fixture?.dispose();
    fixture = undefined;
    boundary = undefined;
  });
  const loadBuild = async (raw: NodeJS.ProcessEnv) => {
    fixture = await createUsRequestBuildFixture();
    await fixture.writeDocument(
      await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    );
    return loadUsRequestBuildDescriptor(raw, fixture.roots);
  };
  const environment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...(await localBuildEnv()),
    ...storage,
  });
  const connect: typeof createDb = (_url, options) => {
    expect(options).toEqual({ max: 2, connectionTimeoutMillis: 2000, statement_timeout: 15000 });
    if (!boundary) throw new Error("Missing transport boundary");
    return boundary.connection;
  };
  it("uses the real checked loader to reject dirty bytes before connecting", async () => {
    let connected = false;
    await expect(
      runUsDatasetCommand(args, await environment(), {
        loadBuild: async (raw) => {
          fixture = await createUsRequestBuildFixture();
          await fixture.writeDocument(
            await captureUsRequestBuildDescriptor(
              { ...fixture.cleanBuild, dirty: true },
              fixture.roots,
            ),
          );
          return loadUsRequestBuildDescriptor(raw, fixture.roots);
        },
        connect: () => {
          connected = true;
          throw new Error("Unexpected connection");
        },
      }),
    ).rejects.toThrow("us_dataset_command_build_invalid");
    expect(connected).toBe(false);
  });
  it("disposes both owned private clients and the bounded pool exactly once on target refusal", async () => {
    boundary = databaseBoundary();
    boundary.state.name = "ordinary_child_is_not_the_fixed_target";
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const end = vi.spyOn(boundary.connection.pool, "end");
    await expect(
      runUsDatasetCommand(args, await environment(), { loadBuild, connect }),
    ).rejects.toThrow("us_dataset_command_target_invalid");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
    expect(boundary.connection.pool.ended).toBe(true);
  });
  it("unwinds exactly the resources already acquired when the second provider acquisition fails", async () => {
    boundary = databaseBoundary();
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const end = vi.spyOn(boundary.connection.pool, "end");
    const original = new Error("provider acquisition raw-secret");
    const error = await runUsDatasetCommand(args, await environment(), {
      loadBuild,
      connect,
      get planTransport(): never {
        throw original;
      },
    }).catch((value: unknown) => value);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_command_storage_unavailable",
    });
    expect(error).toHaveProperty("cause", original);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(boundary.queries).toEqual([]);
  });
  it("preserves pool acquisition errors without exposing their raw diagnostics", async () => {
    const original = new Error("postgres://raw-secret SELECT details");
    const error = await runUsDatasetCommand(args, await environment(), {
      loadBuild,
      connect: () => {
        throw original;
      },
    }).catch((value: unknown) => value);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_command_connection_failed",
    });
    expect(error).toHaveProperty("cause", original);
  });
  it("awaits outstanding query work after pool failure before disposing clients/pool", async () => {
    boundary = databaseBoundary();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const connection = boundary.connection;
    boundary.state.name = "ordinary_child_is_not_the_fixed_target";
    boundary.state.before = async (text) => {
      if (text.includes("current_database()")) {
        connection.pool.emit("error", new Error("pool raw-secret"));
        entered();
        await gate;
      }
    };
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const end = vi.spyOn(connection.pool, "end");
    const pending = runUsDatasetCommand(args, await environment(), { loadBuild, connect });
    void pending.catch(() => {});
    try {
      await Promise.race([ready, pending]);
      expect(destroy).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow("us_dataset_command_connection_failed");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it("does not turn pool disposal failure into successful output and retains the original refusal", async () => {
    boundary = databaseBoundary();
    boundary.state.user = "wrong_user";
    const original = new Error("pool disposal raw-secret");
    const end = vi.spyOn(boundary.connection.pool, "end").mockRejectedValue(original);
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const error = await runUsDatasetCommand(args, await environment(), {
      loadBuild,
      connect,
    }).catch((value: unknown) => value);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_command_disposal_failed",
    });
    expect(error).toHaveProperty("cause");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
    end.mockRestore();
  });
  it("continues exact disposal after a provider destroy throws", async () => {
    boundary = databaseBoundary();
    boundary.state.user = "wrong_user";
    const destroy = vi.spyOn(S3Client.prototype, "destroy").mockImplementationOnce(() => {
      throw new Error("provider destroy raw-secret");
    });
    const end = vi.spyOn(boundary.connection.pool, "end");
    await expect(
      runUsDatasetCommand(args, await environment(), { loadBuild, connect }),
    ).rejects.toThrow("us_dataset_command_disposal_failed");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it("runs the actual complete verify owner and refuses an absent journal without writes", async () => {
    boundary = databaseBoundary();
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const end = vi.spyOn(boundary.connection.pool, "end");
    await expect(
      runUsDatasetCommand(args, await environment(), { loadBuild, connect }),
    ).rejects.toThrow("us_dataset_references_incomplete");
    expect(boundary.queries.filter((text) => text.startsWith("begin")).length).toBeGreaterThan(1);
    expect(
      boundary.queries.filter((text) => text.includes('from "traceability_demo_datasets"')).length,
    ).toBeGreaterThan(1);
    expect(
      boundary.queries.some((text) => /^(insert|update|delete|alter|create)/i.test(text)),
    ).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it("dispatches actual initialize once and preserves its original driver failure before any write", async () => {
    boundary = databaseBoundary();
    const original = new Error("native initialization SQL raw-secret");
    boundary.state.before = async (text) => {
      if (text.includes("pg_advisory_xact_lock")) throw original;
    };
    const error = await runUsDatasetCommand(
      ["initialize", "--confirm-local-synthetic-dataset", ...args.slice(1)],
      await environment(),
      { loadBuild, connect },
    ).catch((value: unknown) => value);
    expect(usDatasetCommandDiagnostic(error)).toEqual({
      code: "us_dataset_command_failed",
      unitKey: "references",
      stage: "references",
    });
    expect(boundary.queries.filter((text) => text.includes("pg_advisory_xact_lock"))).toHaveLength(
      1,
    );
    expect(
      boundary.queries.some((text) => /^(insert|update|delete|alter|create)/i.test(text)),
    ).toBe(false);
    expect(error).toHaveProperty("cause", original);
    expect(boundary.connection.pool.ended).toBe(true);
  });
  it("keeps external transports caller-owned while still closing the refused command pool", async () => {
    boundary = databaseBoundary();
    boundary.state.user = "wrong_user";
    const transport = {
      send: vi.fn(async () => {
        throw new Error("Unexpected provider IO");
      }),
      destroy: vi.fn(),
    };
    await expect(
      runUsDatasetCommand(args, await environment(), {
        loadBuild,
        connect,
        planTransport: transport,
        packageTransport: transport,
      }),
    ).rejects.toThrow("us_dataset_command_target_invalid");
    expect(transport.destroy).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    expect(boundary.connection.pool.ended).toBe(true);
  });
  it("captures environment before awaited build I/O so later caller mutation cannot retarget it", async () => {
    boundary = databaseBoundary();
    boundary.state.user = "wrong_user";
    const raw = await environment();
    const connection: typeof createDb = (url, options) => {
      expect(url).toBe(
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
      );
      return connect(url, options);
    };
    await expect(
      runUsDatasetCommand(args, raw, {
        loadBuild: async (source) => {
          raw.DATABASE_URL = "postgres://unsafe:raw-secret@remote.invalid/db";
          return loadBuild(source);
        },
        connect: connection,
      }),
    ).rejects.toThrow("us_dataset_command_target_invalid");
  });
});
