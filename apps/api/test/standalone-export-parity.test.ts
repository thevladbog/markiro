import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { PALLET_EXPORT_FORMATS, SHIFT_EXPORT_FORMATS } from "@markiro/domain";
import { z } from "zod";
import { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import { ShiftExportSourceService } from "../src/modules/shift-exports/shift-export-source.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

/**
 * The cloud's half of the export parity between the cloud and «Markiro
 * Автоном» (plan ЧЗ of `apps/standalone`). Every case of
 * `packages/domain/test/fixtures/shift-export-parity/cases.json` is a
 * shift's facts in a shape both products read. Here they become the rows
 * the cloud's own `ShiftExportSourceService` reads, and the cloud's own
 * `ShiftExportRunnerService` renders and "uploads" every format; the bytes
 * it uploads, its file names and counts, or the error code it records, must
 * equal `golden.json`. The standalone office's port reads the same cases as
 * its host's rows and must produce the same golden
 * (`apps/standalone/test/export-parity.test.ts`). A legitimate change of
 * the cloud's export regenerates the golden from this test alone:
 * `EXPORT_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run
 * test/standalone-export-parity.test.ts`; the standalone port must then be
 * brought to the same bytes.
 */

const FIXTURES = join(__dirname, "../../../packages/domain/test/fixtures/shift-export-parity");
const TENANT = "tenant-1";
const USER = "user-1";

const instant = z.iso.datetime();
const caseSchema = z.object({
  name: z.string(),
  shift: z.object({
    id: z.string(),
    status: z.enum(["planned", "active", "closed"]),
    productionDate: z.string(),
    monthKey: z.string(),
    seq: z.number().int(),
    createdFrom: z.enum(["office", "station"]),
    closedAt: instant.nullable(),
    closedBy: z.enum(["office", "station"]).nullable(),
    productName: z.string(),
    palletsEnabled: z.boolean(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(z.object({ codeHash: z.string(), scannedAt: instant, canonical: z.string() })),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      boxId: z.string(),
      codeHash: z.string(),
      removed: z.boolean(),
      displaced: z.boolean(),
    }),
  ),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
    }),
  ),
  maxLines: z.array(z.number().int().nullable()),
  palletRuns: z.array(z.string()),
});
type ParityCase = z.infer<typeof caseSchema>;
const casesSchema = z.object({
  documentId: z.uuid(),
  fileDateTime: instant,
  cases: z.array(caseSchema),
});
const outcomeSchema = z.union([
  z.object({ error: z.string() }).strict(),
  z
    .object({
      openPalletSuppressedBoxCount: z.number().int(),
      parts: z.array(
        z
          .object({
            filename: z.string(),
            codeCount: z.number().int(),
            boxCount: z.number().int(),
            palletCount: z.number().int(),
            physicalLineCount: z.number().int(),
            bytes: z.number().int(),
            sha256: z.string(),
            text: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
type Outcome = z.infer<typeof outcomeSchema>;

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const parity = casesSchema.parse(read("cases.json"));

/** The run keys and their target: every advertised shift format at every line limit, then each pallet. */
function runsOf(parityCase: ParityCase) {
  const shiftRuns = parityCase.maxLines.flatMap((maxLines) =>
    SHIFT_EXPORT_FORMATS.map((format) => ({
      key: `${parityCase.name}/${format.id}@${format.version}/${maxLines ?? "-"}`,
      formatId: format.id as string,
      formatVersion: format.version as number,
      maxLines,
      palletId: null as string | null,
    })),
  );
  const palletRuns = parityCase.palletRuns.flatMap((palletId) =>
    PALLET_EXPORT_FORMATS.map((format) => ({
      key: `${parityCase.name}/${format.id}@${format.version}/${palletId}`,
      formatId: format.id as string,
      formatVersion: format.version as number,
      maxLines: null,
      palletId: palletId as string | null,
    })),
  );
  return [...shiftRuns, ...palletRuns];
}

const date = (value: string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The rows the cloud's source reads for `parityCase`, keyed by table: the
 * shift joined with its product, the organization, the registry joined with
 * the codes' history, the box items joined with their boxes, the pallets.
 * The per-pallet loader's own SQL filters and orders the boxes of the pallet
 * (`shift-export-source.service.ts:191-202`): the fake applies that filter
 * and that order as the SQL writes them.
 */
function sourceDb(parityCase: ParityCase, palletId: string | null): Db {
  const { shift } = parityCase;
  const boxById = new Map(parityCase.boxes.map((box) => [box.id, box]));
  const rowsFor = (table: unknown, fields: Record<string, unknown> | undefined): unknown[] => {
    if (table === schema.shifts) {
      return [
        {
          tenantId: TENANT,
          shiftId: shift.id,
          status: shift.status,
          productionDate: shift.productionDate,
          plannedDate: null,
          numberMonthKey: shift.monthKey,
          numberSeq: shift.seq,
          createdFrom: shift.createdFrom === "office" ? "admin" : "station",
          closedAt: date(shift.closedAt),
          productName: shift.productName,
        },
      ];
    }
    if (table === schema.organization) {
      return [{ name: parityCase.organization.name, inn: parityCase.organization.inn }];
    }
    if (table === schema.codeRegistry) {
      return parityCase.codes.map((code) => ({
        tenantId: TENANT,
        shiftId: shift.id,
        codeHash: code.codeHash,
        scannedAt: new Date(code.scannedAt),
        canonicalRaw: code.canonical,
      }));
    }
    if (table === schema.validationCodeReprocessings) return [];
    if (table === schema.boxItems) {
      return parityCase.items.flatMap((item) => {
        const box = boxById.get(item.boxId);
        if (box === undefined) throw new Error(`${parityCase.name}: no box ${item.boxId}`);
        return [
          {
            tenantId: TENANT,
            shiftId: shift.id,
            boxId: box.id,
            sscc: box.sscc,
            closedAt: date(box.closedAt),
            disassembledAt: date(box.disassembledAt),
            palletId: box.palletId,
            codeHash: item.codeHash,
            displacedAt: item.displaced
              ? new Date(parityCase.shift.closedAt ?? box.openedAt)
              : null,
            removedAt: item.removed ? new Date(parityCase.shift.closedAt ?? box.openedAt) : null,
          },
        ];
      });
    }
    if (table === schema.pallets && fields !== undefined && "productName" in fields) {
      const pallet = parityCase.pallets.find((each) => each.id === palletId);
      return pallet === undefined
        ? []
        : [
            {
              sscc: pallet.sscc,
              closedAt: date(pallet.closedAt),
              disassembledAt: date(pallet.disassembledAt),
              productName: shift.productName,
            },
          ];
    }
    if (table === schema.pallets) {
      return parityCase.pallets.map((pallet) => ({
        tenantId: TENANT,
        shiftId: shift.id,
        id: pallet.id,
        sscc: pallet.sscc,
        closedAt: date(pallet.closedAt),
      }));
    }
    if (table === schema.boxes) {
      return parityCase.boxes
        .filter(
          (box) =>
            box.palletId === palletId && box.closedAt !== null && box.disassembledAt === null,
        )
        .sort((left, right) =>
          left.closedAt === right.closedAt
            ? left.id < right.id
              ? -1
              : 1
            : (left.closedAt ?? "") < (right.closedAt ?? "")
              ? -1
              : 1,
        )
        .map((box) => ({ sscc: box.sscc }));
    }
    throw new Error(`${parityCase.name}: the source read an unexpected table`);
  };
  const select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const rows = Promise.resolve(rowsFor(table, fields));
      const node = {
        innerJoin: () => node,
        leftJoin: () => node,
        where: () => node,
        orderBy: () => node,
        limit: () => node,
        then: rows.then.bind(rows),
      };
      return node;
    },
  });
  const tx = {
    select,
    execute: async () => ({
      rows: [{ sourceSnapshotStartedAt: new Date(parity.fileDateTime) }],
    }),
  };
  return {
    transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as Db;
}

interface ExportRow {
  id: string;
  tenantId: string;
  shiftId: string | null;
  palletId: string | null;
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  status: string;
  errorCode: string | null;
  attemptCount: number;
  createdByUserId: string;
  updatedAt: Date;
}

/** The export's row as the runner's claim, snapshot, lease and publication change it. */
function runnerDb(row: ExportRow) {
  const artifacts: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const boundary = {
    select: () => ({
      from: () => {
        const rows = Promise.resolve([row]);
        const node = { where: () => node, limit: () => node, then: rows.then.bind(rows) };
        return node;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const apply = () => {
          const { attemptCount, ...rest } = values;
          Object.assign(row, rest);
          if (attemptCount !== undefined) row.attemptCount += 1;
          return [row];
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
        if (table === schema.shiftExportArtifacts) artifacts.push(...rows);
        else if (table === schema.tenantAuditEvents) audits.push(...rows);
      },
    }),
  };
  const db = {
    ...boundary,
    transaction: async (run: (tx: typeof boundary) => Promise<unknown>) => run(boundary),
  } as unknown as Db;
  return { db, artifacts, audits };
}

/** What the runner uploaded, by object key. */
function storage() {
  const objects = new Map<string, Buffer>();
  const store = {
    putVerified: async (key: string, body: Buffer, _mime: string, sha256: string) => {
      objects.set(key, body);
      return { byteSize: body.byteLength, sha256 };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageService;
  return { store, objects };
}

async function cloudOutcome(
  parityCase: ParityCase,
  run: ReturnType<typeof runsOf>[number],
): Promise<Outcome> {
  const row: ExportRow = {
    id: parity.documentId,
    tenantId: TENANT,
    shiftId: run.palletId === null ? parityCase.shift.id : null,
    palletId: run.palletId,
    formatId: run.formatId,
    formatVersion: run.formatVersion,
    maxLines: run.maxLines,
    status: "queued",
    errorCode: null,
    attemptCount: 0,
    createdByUserId: USER,
    updatedAt: new Date(parity.fileDateTime),
  };
  const runner = runnerDb(row);
  const uploaded = storage();
  await new ShiftExportRunnerService(
    runner.db,
    new ShiftExportSourceService(sourceDb(parityCase, run.palletId)),
    uploaded.store,
  ).run(row.id, { retryCount: 0, retryLimit: 0 });
  if (row.status !== "ready") return { error: row.errorCode ?? row.status };
  const completed = runner.audits.find((audit) =>
    String(audit.action).endsWith("export.completed"),
  );
  const metadata = z
    .object({ openPalletSuppressedBoxCount: z.number().int() })
    .parse((completed as { after?: unknown } | undefined)?.after);
  const parts = z
    .array(
      z.object({
        partNumber: z.number().int(),
        objectKey: z.string(),
        filename: z.string(),
        codeCount: z.number().int(),
        boxCount: z.number().int(),
        palletCount: z.number().int(),
        physicalLineCount: z.number().int(),
      }),
    )
    .parse(runner.artifacts)
    .sort((left, right) => left.partNumber - right.partNumber);
  return {
    openPalletSuppressedBoxCount: metadata.openPalletSuppressedBoxCount,
    parts: parts.map((part) => {
      const body = uploaded.objects.get(part.objectKey);
      if (body === undefined) throw new Error(`${part.objectKey} was not uploaded`);
      return {
        filename: part.filename,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        palletCount: part.palletCount,
        physicalLineCount: part.physicalLineCount,
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      };
    }),
  };
}

describe("the cloud's exports over the parity cases (plan ЧЗ of apps/standalone)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("render exactly the golden bytes, names, counts and refusals", async () => {
    // The pallet loader reads the clock for `file_date_time` (`new Date()`,
    // `shift-export-source.service.ts:207`), the shift loader the database's
    // `transaction_timestamp()`: both are the cases' one instant here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(parity.fileDateTime));
    const outcomes: Record<string, Outcome> = {};
    for (const parityCase of parity.cases) {
      for (const run of runsOf(parityCase)) {
        outcomes[run.key] = await cloudOutcome(parityCase, run);
      }
    }
    if (process.env.EXPORT_PARITY_WRITE === "1") {
      writeFileSync(join(FIXTURES, "golden.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
    }
    const golden = z.record(z.string(), outcomeSchema).parse(read("golden.json"));
    expect(Object.keys(outcomes)).toEqual(Object.keys(golden));
    for (const [key, outcome] of Object.entries(outcomes)) {
      expect(outcome, key).toEqual(golden[key]);
    }
  });
});
