import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import type { InventoryDocumentFormatDescriptor } from "@markiro/domain";

import {
  buildInventoryDocumentZip,
  InventoryDocumentGeneratorRegistry,
  InventoryDocumentRunnerService,
  type InventoryDocumentGeneratedPart,
  type InventoryDocumentZipArtifact,
} from "../src/modules/inventories/inventory-document-runner.service";
import type { InventoryResultSourceService } from "../src/modules/inventories/inventory-result-source.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

const artifacts: InventoryDocumentZipArtifact[] = [
  {
    filename: "stock.csv",
    mimeType: "text/csv; charset=utf-8",
    bytes: new TextEncoder().encode("code,date\r\nA,2025-09-01\r\n"),
    sha256: "a0a8633b6b3779fd3c4d3210ef91daffaffe45313549ff82903217622ba61ee1",
    byteSize: 25,
    rowCount: 1,
    codeCount: 1,
    boxCount: 0,
    formatId: "synthetic_stock",
    formatVersion: 1,
    partNumber: 1,
  },
];

describe("inventory document ZIP", () => {
  it("is byte-deterministic and contains an exact checksummed manifest", () => {
    const first = buildInventoryDocumentZip("run-1", 7, artifacts);
    const second = buildInventoryDocumentZip("run-1", 7, [...artifacts].reverse());

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const archive = unzipSync(first);
    expect(Object.keys(archive)).toEqual(["manifest.json", "stock.csv"]);
    expect(strFromU8(archive["manifest.json"]!)).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: "run-1",
          resultRevision: 7,
          artifacts: [
            {
              name: "stock.csv",
              mimeType: "text/csv; charset=utf-8",
              bytes: 25,
              sha256: "a0a8633b6b3779fd3c4d3210ef91daffaffe45313549ff82903217622ba61ee1",
              rowCount: 1,
              codeCount: 1,
              boxCount: 0,
              formatId: "synthetic_stock",
              formatVersion: 1,
              partNumber: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(createHash("sha256").update(archive["stock.csv"]!).digest("hex")).toBe(
      artifacts[0]!.sha256,
    );
  });

  it.each(["../escape.csv", "/root.csv", "nested/file.csv", "nested\\file.csv", "manifest.json"])(
    "rejects unsafe artifact filename %s",
    (filename) => {
      expect(() => buildInventoryDocumentZip("run-1", 7, [{ ...artifacts[0]!, filename }])).toThrow(
        "INVENTORY_DOCUMENT_ARCHIVE_FILENAME_INVALID",
      );
    },
  );

  it("rejects duplicate and case-folding filename collisions", () => {
    expect(() =>
      buildInventoryDocumentZip("run-1", 7, [
        artifacts[0]!,
        { ...artifacts[0]!, filename: "STOCK.CSV", partNumber: 2 },
      ]),
    ).toThrow("INVENTORY_DOCUMENT_ARCHIVE_FILENAME_COLLISION");
  });
});

const descriptor: InventoryDocumentFormatDescriptor = {
  id: "synthetic_stock",
  version: 1,
  label: "Synthetic stock",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["verified"],
  supportsParts: false,
  availability: "available",
};

interface RunRow {
  id: string;
  tenantId: string;
  inventoryId: string;
  resultRevision: number;
  selectedFormats: Array<{ id: string; version: number }>;
  requestDigest: string;
  status: "queued" | "processing" | "ready" | "failed";
  errorCode: string | null;
  createdByUserId: string;
  idempotencyKey: string;
  sourceSnapshotStartedAt: Date | null;
  sourceSnapshotCompletedAt: Date | null;
  completedAt: Date | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    inventoryId: "60000000-0000-4000-8000-000000000001",
    resultRevision: 7,
    selectedFormats: [{ id: descriptor.id, version: descriptor.version }],
    requestDigest: "0".repeat(64),
    status: "queued",
    errorCode: null,
    createdByUserId: "user-1",
    idempotencyKey: "70000000-0000-4000-8000-000000000001",
    sourceSnapshotStartedAt: null,
    sourceSnapshotCompletedAt: null,
    completedAt: null,
    attemptCount: 0,
    createdAt: new Date("2026-08-26T09:00:00.000Z"),
    updatedAt: new Date("2026-08-26T09:00:00.000Z"),
    ...overrides,
  };
}

function runnerDb(
  initial = runRow(),
  options: { failPublication?: boolean; commitThenThrow?: boolean } = {},
) {
  const state = {
    row: { ...initial },
    artifacts: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
  };
  let publicationFailed = false;

  const boundary = (target: typeof state) => ({
    select: () => ({
      from: (table: unknown) => {
        const value =
          table === schema.inventoryDocumentArtifacts
            ? target.artifacts
            : table === schema.inventories
              ? [{ status: "closed", resultRevision: target.row.resultRevision }]
              : [target.row];
        const node = {
          where: () => node,
          limit: () => node,
          for: () => node,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(value).then(resolve, reject),
        };
        return node;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const apply = () => {
          if ("attemptCount" in values) {
            if (
              target.row.status === "processing" &&
              target.row.updatedAt.getTime() > Date.now() - 20_000
            ) {
              return [];
            }
            target.row.attemptCount += 1;
            target.row.status = "processing";
            target.row.updatedAt = values.updatedAt as Date;
          } else {
            Object.assign(target.row, values);
          }
          return [target.row];
        };
        const node = {
          where: () => node,
          returning: async () => apply(),
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(apply()).then(resolve, reject),
        };
        return node;
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === schema.inventoryDocumentArtifacts) {
          if (options.failPublication) {
            publicationFailed = true;
            throw new Error("publication failed: sensitive");
          }
          target.artifacts.push(...rows);
        } else if (table === schema.tenantAuditEvents) {
          target.audits.push(...rows);
        }
      },
    }),
  });

  const db = {
    ...boundary(state),
    transaction: async (run: (tx: Db) => Promise<unknown>) => {
      const working = {
        row: { ...state.row },
        artifacts: [...state.artifacts],
        audits: [...state.audits],
      };
      let result: unknown;
      try {
        result = await run(boundary(working) as unknown as Db);
      } catch (error) {
        publicationFailed = true;
        throw error;
      }
      state.row = working.row;
      state.artifacts = working.artifacts;
      state.audits = working.audits;
      if (options.commitThenThrow && state.row.status === "ready") {
        publicationFailed = true;
        throw new Error("commit acknowledgement lost");
      }
      return result;
    },
  } as unknown as Db;
  return { db, state, publicationFailed: () => publicationFailed };
}

function runnerStorage(failPut = false) {
  const objects = new Set<string>();
  return {
    objects,
    putVerified: vi.fn(async (key: string, body: Buffer, _mime: string, sha256: string) => {
      objects.add(key);
      if (failPut) throw new Error("storage failed: sensitive");
      return { byteSize: body.byteLength, sha256 };
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  } as unknown as ObjectStorageService & {
    objects: Set<string>;
    putVerified: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

function inventorySource(revision = 7): InventoryResultSourceService {
  return {
    load: vi.fn(async () => ({
      inventoryId: runRow().inventoryId,
      snapshotId: "80000000-0000-4000-8000-000000000001",
      resultRevision: revision,
      sourceSnapshotStartedAt: "2026-08-26T10:00:00.000Z",
      expected: [],
      verified: [],
      writeOffCandidates: [],
      protected: [],
      ineligible: [],
      unknown: [],
      oldBoxes: [],
      newBoxes: [],
      observedDateGroups: [],
    })),
  } as unknown as InventoryResultSourceService;
}

function syntheticRegistry(
  parts: readonly InventoryDocumentGeneratedPart[] = [
    {
      partNumber: 1,
      filename: "stock.csv",
      mimeType: descriptor.mimeType,
      bytes: artifacts[0]!.bytes,
      rowCount: 1,
      codeCount: 1,
      boxCount: 0,
    },
  ],
) {
  return new InventoryDocumentGeneratorRegistry([
    { descriptor, generate: vi.fn(async () => parts) },
  ]);
}

describe("inventory document runner", () => {
  it("publishes synthetic output with verified metadata from the frozen revision", async () => {
    const fake = runnerDb();
    const storage = runnerStorage();
    const runner = new InventoryDocumentRunnerService(
      fake.db,
      inventorySource(),
      storage,
      syntheticRegistry(),
    );

    await runner.run(fake.state.row.id, { retryCount: 0, retryLimit: 5 });

    expect(fake.state.row.status).toBe("ready");
    expect(fake.state.row.attemptCount).toBe(1);
    expect(fake.state.row.sourceSnapshotStartedAt?.toISOString()).toBe("2026-08-26T10:00:00.000Z");
    expect(fake.state.artifacts).toEqual([
      expect.objectContaining({
        formatId: descriptor.id,
        formatVersion: 1,
        filename: "stock.csv",
        byteSize: 25,
        sha256: artifacts[0]!.sha256,
      }),
    ]);
    expect(storage.putVerified).toHaveBeenCalledWith(
      `tenants/tenant-1/inventory-documents/${fake.state.row.id}/attempt-1/synthetic_stock-v1-part-1`,
      expect.any(Buffer),
      descriptor.mimeType,
      artifacts[0]!.sha256,
    );
  });

  it("fails closed before upload when the frozen result revision changed", async () => {
    const fake = runnerDb();
    const storage = runnerStorage();
    const runner = new InventoryDocumentRunnerService(
      fake.db,
      inventorySource(8),
      storage,
      syntheticRegistry(),
    );

    await runner.run(fake.state.row.id, { retryCount: 0, retryLimit: 5 });

    expect(fake.state.row.status).toBe("failed");
    expect(fake.state.row.errorCode).toBe("STALE_RESULT_REVISION");
    expect(storage.putVerified).not.toHaveBeenCalled();
  });

  it("deletes every attempted object after a known storage failure", async () => {
    const fake = runnerDb();
    const storage = runnerStorage(true);
    const runner = new InventoryDocumentRunnerService(
      fake.db,
      inventorySource(),
      storage,
      syntheticRegistry(),
    );

    await expect(runner.run(fake.state.row.id, { retryCount: 5, retryLimit: 5 })).rejects.toThrow(
      "storage failed",
    );

    expect(fake.state.row.status).toBe("failed");
    expect(fake.state.row.errorCode).toBe("STORAGE_FAILED");
    expect(storage.objects.size).toBe(0);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it("preserves uploaded objects when the ready commit acknowledgement is ambiguous", async () => {
    const fake = runnerDb(runRow(), { commitThenThrow: true });
    const storage = runnerStorage();
    const runner = new InventoryDocumentRunnerService(
      fake.db,
      inventorySource(),
      storage,
      syntheticRegistry(),
    );

    await runner.run(fake.state.row.id, { retryCount: 0, retryLimit: 5 });

    expect(fake.state.row.status).toBe("ready");
    expect(storage.objects.size).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("does not steal a live lease but reclaims an expired processing attempt", async () => {
    const live = runnerDb(runRow({ status: "processing", attemptCount: 1, updatedAt: new Date() }));
    const liveStorage = runnerStorage();
    await new InventoryDocumentRunnerService(
      live.db,
      inventorySource(),
      liveStorage,
      syntheticRegistry(),
    ).run(live.state.row.id, { retryCount: 1, retryLimit: 5 });
    expect(liveStorage.putVerified).not.toHaveBeenCalled();
    expect(live.state.row.attemptCount).toBe(1);

    const expired = runnerDb(
      runRow({
        status: "processing",
        attemptCount: 1,
        updatedAt: new Date(Date.now() - 60_000),
      }),
    );
    const expiredStorage = runnerStorage();
    await new InventoryDocumentRunnerService(
      expired.db,
      inventorySource(),
      expiredStorage,
      syntheticRegistry(),
    ).run(expired.state.row.id, { retryCount: 1, retryLimit: 5 });
    expect(expired.state.row.status).toBe("ready");
    expect(expired.state.row.attemptCount).toBe(2);
  });
});
