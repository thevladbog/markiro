import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  factReceiptsSchema,
  WAREHOUSE_OUTCOMES,
  WAREHOUSE_REASONS,
  WAREHOUSE_RECEIPT_CODES,
  WAREHOUSE_UNAVAILABLE,
  warehouseBatchSchema,
  warehouseLookupResultSchema,
  warehouseLookupSchema,
} from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("the warehouse reprint on the wire (plan СКЛ)", () => {
  it("reads every fixture as the host writes it", () => {
    for (const name of ["warehouse-lookup-code.json", "warehouse-lookup-sscc.json"]) {
      expect(warehouseLookupSchema.parse(fixture(name)), name).toEqual(fixture(name));
    }
    for (const name of [
      "warehouse-lookup-found-unit.json",
      "warehouse-lookup-found-pallet.json",
      "warehouse-lookup-found-imported-unit.json",
      "warehouse-lookup-not-found.json",
      "warehouse-lookup-unavailable.json",
      "warehouse-lookup-unavailable-imported-no-shift.json",
      "warehouse-lookup-unavailable-imported-no-production-date.json",
      "warehouse-lookup-unavailable-imported-product-unknown.json",
    ]) {
      expect(warehouseLookupResultSchema.parse(fixture(name)), name).toEqual(fixture(name));
    }
    expect(warehouseBatchSchema.parse(fixture("warehouse-records-request.json"))).toEqual(
      fixture("warehouse-records-request.json"),
    );
    expect(factReceiptsSchema.parse(fixture("warehouse-records-response.json"))).toEqual(
      fixture("warehouse-records-response.json"),
    );
  });

  it("marks an imported record and gives it no station and no operator", () => {
    const found = warehouseLookupResultSchema.parse(
      fixture("warehouse-lookup-found-imported-unit.json"),
    );
    if (found.status !== "found") throw new Error("the fixture is found");
    expect(found.source.imported).toBe(true);
    expect(found.source.operatorName).toBeNull();
    const native = warehouseLookupResultSchema.parse(fixture("warehouse-lookup-found-unit.json"));
    if (native.status !== "found") throw new Error("the fixture is found");
    expect(native.source.imported).toBeUndefined();
  });

  it("has an operator-readable message and title for every unavailable reason", () => {
    const ru = JSON.parse(readFileSync(new URL("../src/i18n/ru.json", testModuleUrl), "utf8")) as {
      floor: {
        warehouse: { errors: Record<string, string>; banner: { title: Record<string, string> } };
      };
    };
    for (const reason of WAREHOUSE_UNAVAILABLE) {
      expect(ru.floor.warehouse.errors[reason], reason).toMatch(/\S/);
      expect(ru.floor.warehouse.banner.title[reason], reason).toMatch(/\S/);
    }
  });

  it("asks one thing at a time, and nothing the host does not know", () => {
    expect(warehouseLookupSchema.safeParse({}).success).toBe(false);
    expect(
      warehouseLookupSchema.safeParse({ codeHash: "a".repeat(64), sscc: "046006820000015000" })
        .success,
    ).toBe(false);
    expect(warehouseLookupSchema.safeParse({ raw: "x" }).success).toBe(false);
  });

  it("keeps the full code of a unit with its separator", () => {
    const found = warehouseLookupResultSchema.parse(fixture("warehouse-lookup-found-unit.json"));
    if (found.status !== "found") throw new Error("the fixture is found");
    expect(found.source.canonical).toBe("010460068200001321S000001\u001d93Tail");
  });

  it("knows the host's receipt codes, reasons and outcomes", () => {
    expect(fixture("warehouse-receipt-codes.json")).toEqual({
      codes: [...WAREHOUSE_RECEIPT_CODES],
    });
    expect([...WAREHOUSE_REASONS]).toEqual(["not_printed", "damaged", "lost"]);
    expect([...WAREHOUSE_OUTCOMES]).toEqual(["sent", "unknown", "failed", "verified", "cancelled"]);
  });

  it("refuses a lookup that carries anything beyond its one question", () => {
    expect(warehouseLookupSchema.safeParse({ codeHash: "a".repeat(64), raw: "x" }).success).toBe(
      false,
    );
    expect(warehouseLookupSchema.safeParse({ sscc: "046006820000015000", raw: "x" }).success).toBe(
      false,
    );
    expect(warehouseLookupSchema.safeParse({ codeHash: "a".repeat(64) }).success).toBe(true);
    expect(warehouseLookupSchema.safeParse({ sscc: "046006820000015000" }).success).toBe(true);
  });

  it.each([
    ["a kind the host does not print", { kind: "pack" }],
    ["an empty subject id", { subjectId: "" }],
    ["an empty identity", { identity: "" }],
    ["a shift id that is no uuid", { shiftId: "not-a-uuid" }],
    ["a device id that is no uuid", { deviceId: "not-a-uuid" }],
    ["a negative item count", { itemCount: -1 }],
    ["a fractional item count", { itemCount: 1.5 }],
    ["a negative box count", { boxCount: -1 }],
    ["a fractional box count", { boxCount: 0.5 }],
    ["a counterparty name that is missing", { counterpartyName: undefined }],
    ["an operator name that is missing", { operatorName: undefined }],
    ["a canonical code that is no text", { canonical: 5 }],
    ["an SSCC that is no text", { sscc: 5 }],
    ["a product that is missing", { product: undefined }],
  ])("refuses a found record with %s", (_name, patch) => {
    const found = fixture("warehouse-lookup-found-pallet.json") as { source: object };
    expect(
      warehouseLookupResultSchema.safeParse({
        status: "found",
        source: { ...found.source, ...patch },
      }).success,
    ).toBe(false);
  });

  it("accepts the edges of a found record and refuses an answer of another shape", () => {
    const found = fixture("warehouse-lookup-found-pallet.json") as { source: object };
    expect(
      warehouseLookupResultSchema.safeParse({
        status: "found",
        source: { ...found.source, itemCount: 0, boxCount: 0 },
      }).success,
    ).toBe(true);
    expect(warehouseLookupResultSchema.safeParse({ status: "found" }).success).toBe(false);
    expect(warehouseLookupResultSchema.safeParse({ status: "elsewhere" }).success).toBe(false);
    expect(
      warehouseLookupResultSchema.safeParse({ status: "unavailable", reason: "lost" }).success,
    ).toBe(false);
    expect(warehouseLookupResultSchema.safeParse({ status: "unavailable" }).success).toBe(false);
    expect(
      warehouseLookupResultSchema.safeParse({ status: "unavailable", reason: "released" }).success,
    ).toBe(true);
  });

  it.each([
    ["a record id that is no uuid", { id: "x" }],
    ["a session id that is no uuid", { sessionId: "x" }],
    ["a job id that is no uuid", { jobId: "x" }],
    ["a negative attempt", { attempt: -1 }],
    ["a fractional attempt", { attempt: 0.5 }],
    ["a subject kind the host does not print", { subjectKind: "pack" }],
    ["an empty subject id", { subjectId: "" }],
    ["an empty identity", { identity: "" }],
    ["a repair the station does not make", { repair: "other" }],
    ["a repair that is missing", { repair: undefined }],
    ["an empty template id", { templateId: "" }],
    ["a negative template revision", { templateRev: -1 }],
    ["a fractional template revision", { templateRev: 1.5 }],
    ["an outcome the station does not record", { outcome: "queued" }],
    ["an error code that is missing", { errorCode: undefined }],
    ["an operator id that is no uuid", { operatorId: "x" }],
    ["an operator id that is missing", { operatorId: undefined }],
    ["an instant that is missing", { occurredAt: undefined }],
  ])("refuses a record with %s", (_name, patch) => {
    const batch = fixture("warehouse-records-request.json") as { records: object[] };
    const [first] = batch.records;
    expect(warehouseBatchSchema.safeParse({ records: [{ ...first, ...patch }] }).success).toBe(
      false,
    );
  });

  it("accepts the edges of a record: attempt 0, revision 0, every outcome, reason and kind", () => {
    const batch = fixture("warehouse-records-request.json") as { records: object[] };
    const [first] = batch.records;
    const edge = { ...first, attempt: 0, templateRev: 0, operatorId: null, errorCode: null };
    expect(warehouseBatchSchema.safeParse({ records: [edge] }).success).toBe(true);
    for (const outcome of WAREHOUSE_OUTCOMES) {
      expect(warehouseBatchSchema.safeParse({ records: [{ ...edge, outcome }] }).success).toBe(
        true,
      );
    }
    for (const reasonCode of WAREHOUSE_REASONS) {
      expect(warehouseBatchSchema.safeParse({ records: [{ ...edge, reasonCode }] }).success).toBe(
        true,
      );
    }
    for (const subjectKind of ["unit", "box", "pallet"]) {
      expect(warehouseBatchSchema.safeParse({ records: [{ ...edge, subjectKind }] }).success).toBe(
        true,
      );
    }
  });

  it("takes 1 to 100 records in a batch, and nothing else beside them", () => {
    const batch = fixture("warehouse-records-request.json") as { records: object[] };
    const [first] = batch.records;
    expect(warehouseBatchSchema.safeParse({ records: Array(100).fill(first) }).success).toBe(true);
    expect(warehouseBatchSchema.safeParse({ records: Array(101).fill(first) }).success).toBe(false);
    expect(warehouseBatchSchema.safeParse({ records: [first], addedLater: 1 }).success).toBe(false);
  });

  it("refuses a record with a field the host would refuse to read", () => {
    const batch = fixture("warehouse-records-request.json") as { records: object[] };
    const [first] = batch.records;
    expect(warehouseBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(warehouseBatchSchema.safeParse({ records: [{ ...first, addedLater: 1 }] }).success).toBe(
      false,
    );
    expect(
      warehouseBatchSchema.safeParse({ records: [{ ...first, reasonCode: "x" }] }).success,
    ).toBe(false);
  });
});
