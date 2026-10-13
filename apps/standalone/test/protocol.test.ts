import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PALLET_EXPORT_FORMATS,
  SHIFT_EXPORT_FORMATS,
  type ProductLabelEvent,
  type ReprintReason,
  type VerificationPolicy,
} from "@markiro/domain";

import {
  PROTOCOL_VERSION,
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  boxReportRowsSchema,
  canonicalSaltSchema,
  categoryTemplateDefaultSchema,
  changesResponseSchema,
  codeCheckSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
  counterpartyUpdateSchema,
  employeeCreateSchema,
  employeeRecordSchema,
  employeeUpdateSchema,
  credentialSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  deviceShiftCreateSchema,
  deviceShiftSchema,
  deviceShiftsSchema,
  deviceUpdateSchema,
  enteredShiftSchema,
  errorBodySchema,
  FACT_OUTCOMES,
  FACT_RECEIPT_CODES,
  factBatchSchema,
  factReceiptsSchema,
  factRecordSchema,
  helloSchema,
  labelTemplateRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeBoxSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officePalletSchema,
  officeProductSchema,
  officeSessionSchema,
  officeShiftSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  palletReportRowsSchema,
  officeUserUpdateSchema,
  operatorBadgeRecordSchema,
  operatorCreateSchema,
  operatorRecordSchema,
  operatorUpdateSchema,
  orgLogoPutSchema,
  orgLogoStateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  palletSheetCreateSchema,
  palletSheetDefaultUpdateSchema,
  palletSheetSchema,
  palletSheetUpdateSchema,
  palletSheetsSchema,
  pairingCodeRequestSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  productCreateSchema,
  productGroupSchema,
  productRecordSchema,
  productUpdateSchema,
  LABEL_VERIFICATIONS,
  REPRINT_REASONS,
  SHIFT_SUPPORTS,
  UNIT_LABEL_ERROR_CODES,
  UNIT_LABEL_EVENTS,
  unitLabelFactSchema,
  validationPrintSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftEnterSchema,
  shiftExportRecordSchema,
  shiftExportRowsSchema,
  shiftUpdateSchema,
  SCAN_RAW_KINDS,
  SCAN_VERDICTS,
  siteRecordSchema,
  ssccBlockRequestSchema,
  ssccBlockSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
  stockTemplateSchema,
  templateCreateSchema,
  templateDefaultsSchema,
  templateDefaultsUpdateSchema,
  templateSpecSchema,
  templateUpdateSchema,
} from "../src/host/protocol.js";
import {
  badgeCreate,
  counterpartyCreate,
  counterpartyUpdate,
  deviceShiftCreate,
  employeeCreate,
  employeeUpdate,
  deviceUpdate,
  lineCreate,
  lineUpdate,
  operatorCreate,
  operatorUpdate,
  pairingCodeRequest,
  productCreate,
  productUpdate,
  shiftClose,
  shiftCreate,
  shiftExportRecord,
  shiftUpdate,
  STATION_SHIFT_ENTER,
  templateCreate,
  templateDefaultsUpdate,
  templateUpdate,
} from "../src/host/requests.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
// for browser asset bundling (see `vite:asset-import-meta-url`); under the
// jsdom test environment that rewrite resolves against a fake browser
// location instead of this file's real path, breaking a plain fixture read.
// Binding the value first keeps this a normal runtime URL resolution.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("protocol schemas parse the shared Rust fixtures", () => {
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: PROTOCOL_VERSION,
      minProtocol: 1,
      initialized: false,
    });
  });

  it("error bodies", () => {
    expect(errorBodySchema.parse(fixture("error-not-found.json")).error.code).toBe("not_found");
    expect(errorBodySchema.parse(fixture("error-with-details.json")).error.details).toEqual({
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 3,
    });
  });

  it("rejects unknown fields in payloads the Rust shell rebuilds from proto types", () => {
    const hello = { ...(fixture("hello.json") as Record<string, unknown>), extra: true };
    expect(helloSchema.safeParse(hello).success).toBe(false);
  });

  it("rejects non-object error details, like the Rust Map type", () => {
    const body = fixture("error-with-details.json") as { error: Record<string, unknown> };
    expect(
      errorBodySchema.safeParse({ error: { ...body.error, details: "not an object" } }).success,
    ).toBe(false);
  });

  it("pairing code", () => {
    expect(pairingCodeSchema.parse(fixture("pairing-code.json"))).toMatchObject({
      code: "7K3MQ9XV2D",
      expiresAt: "2026-09-26T09:25:00Z",
    });
  });

  it("device record", () => {
    expect(deviceRecordSchema.parse(fixture("device-record.json"))).toMatchObject({
      kind: "station",
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      revokedAt: null,
    });
  });

  it("change feed", () => {
    const rawChanges = fixture("changes-response.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    expect(changes.items).toHaveLength(4);
    expect(lineRecordSchema.parse(changes.items[0]?.data)).toEqual(rawChanges.items[0]?.data);
    expect(orgRecordSchema.parse(changes.items[1]?.data)).toEqual(rawChanges.items[1]?.data);
    expect(siteRecordSchema.parse(changes.items[2]?.data)).toEqual(rawChanges.items[2]?.data);
    expect(changes.items[3]).toMatchObject({ deleted: true });
    expect(changes.items[3]?.data).toBeUndefined();
  });

  it("change feed of people", () => {
    const rawChanges = fixture("changes-people.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    expect(changes.items).toHaveLength(4);
    expect(operatorRecordSchema.parse(changes.items[0]?.data)).toEqual(rawChanges.items[0]?.data);
    expect(operatorBadgeRecordSchema.parse(changes.items[1]?.data)).toEqual(
      rawChanges.items[1]?.data,
    );
    expect(changes.items.slice(2).map((item) => [item.entity, item.deleted, item.data])).toEqual([
      ["operator_badges", true, undefined],
      ["operators", true, undefined],
    ]);
  });

  it("change feed of the catalog", () => {
    const rawChanges = fixture("changes-catalog.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    const raw = (index: number) => rawChanges.items[index]?.data;
    expect(changes.items).toHaveLength(8);
    expect(labelTemplateRecordSchema.parse(changes.items[0]?.data)).toEqual(raw(0));
    expect(labelTemplateRecordSchema.parse(changes.items[1]?.data)).toEqual(raw(1));
    expect(orgRecordSchema.parse(changes.items[2]?.data)).toEqual(raw(2));
    expect(categoryTemplateDefaultSchema.parse(changes.items[3]?.data)).toEqual(raw(3));
    expect(productRecordSchema.parse(changes.items[4]?.data)).toEqual(raw(4));
    expect(productRecordSchema.parse(changes.items[5]?.data)).toEqual(raw(5));
    expect(changes.items.slice(6).map((item) => [item.entity, item.id, item.data])).toEqual([
      ["category_template_defaults", "15:pallet", undefined],
      ["label_templates", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", undefined],
    ]);
  });
});

/** `data` of item `index` of a feed fixture, as an object. */
function feedRecord(name: string, index: number): Record<string, unknown> {
  const changes = changesResponseSchema.parse(fixture(name));
  const data = changes.items[index]?.data;
  if (typeof data !== "object" || data === null) throw new Error(`${name} has no record ${index}`);
  return { ...data };
}

describe("feed records that grant access", () => {
  const OPERATOR = feedRecord("changes-people.json", 0);
  const BADGE = feedRecord("changes-people.json", 1);
  const SITE = feedRecord("changes-response.json", 2);

  it("have exactly their keys: an unknown key or a missing one fails closed", () => {
    for (const [schema, record] of [
      [operatorRecordSchema, OPERATOR],
      [operatorBadgeRecordSchema, BADGE],
      [siteRecordSchema, SITE],
    ] as const) {
      expect(schema.safeParse(record).success).toBe(true);
      expect(schema.safeParse({ ...record, addedLater: true }).success).toBe(false);
    }
    const withoutRole = Object.fromEntries(
      Object.entries(OPERATOR).filter(([key]) => key !== "role"),
    );
    expect(operatorRecordSchema.safeParse(withoutRole).success).toBe(false);
  });

  it("take a personnel number of 3 to 12 digits and a badge's operator by UUID", () => {
    for (const login of ["042", "123456789012"]) {
      expect(operatorRecordSchema.safeParse({ ...OPERATOR, login }).success).toBe(true);
    }
    for (const login of ["42", "1234567890123", "0042a", " 0042"]) {
      expect(operatorRecordSchema.safeParse({ ...OPERATOR, login }).success).toBe(false);
    }
    expect(operatorBadgeRecordSchema.safeParse({ ...BADGE, operatorId: "0042" }).success).toBe(
      false,
    );
  });
});

// Host responses pass through the shell unchanged: lenient, like the Rust
// response types. Requests are strict, like the host's deny_unknown_fields.
const RESPONSES = [
  ["device-info.json", deviceInfoSchema],
  ["device-record.json", deviceRecordSchema],
  ["office-user.json", officeUserSchema],
  ["office-session.json", officeSessionSchema],
  ["bootstrap-response.json", bootstrapResponseSchema],
  ["org-profile.json", orgProfileSchema],
  ["org-logo.json", orgLogoStateSchema],
  ["pallet-sheets.json", palletSheetsSchema],
  ["pallet-sheet.json", palletSheetSchema],
  ["sscc-state.json", ssccStateSchema],
  ["office-user-record.json", officeUserRecordSchema],
  ["error-unauthorized.json", errorBodySchema],
  ["pairing-code.json", pairingCodeSchema],
  ["changes-response.json", changesResponseSchema],
  ["counterparty-record.json", counterpartyRecordSchema],
  ["employee-record.json", employeeRecordSchema],
  ["office-line.json", officeLineSchema],
  ["office-operator.json", officeOperatorSchema],
  ["badge-salt.json", badgeSaltSchema],
  ["product-group.json", productGroupSchema],
  ["office-product.json", officeProductSchema],
  ["template-summary.json", labelTemplateSummarySchema],
  ["label-template.json", labelTemplateSchema],
  ["template-defaults.json", templateDefaultsSchema],
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["office-shift-validation.json", officeShiftSchema],
  ["office-shift-validation-print.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["box-report-rows.json", boxReportRowsSchema],
  ["pallet-report-rows.json", palletReportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-snapshot-too-large.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
  ["device-shifts.json", deviceShiftsSchema],
  ["device-shift-entered.json", enteredShiftSchema],
  ["device-shift-entered-pallets.json", enteredShiftSchema],
  ["device-shift-entered-sheet.json", enteredShiftSchema],
  ["device-shift-entered-validation.json", enteredShiftSchema],
  ["device-shift-entered-validation-print.json", enteredShiftSchema],
  ["sscc-block.json", ssccBlockSchema],
  ["code-check-free.json", codeCheckSchema],
  ["code-check-taken.json", codeCheckSchema],
  ["facts-response.json", factReceiptsSchema],
] as const;

const REQUESTS = [
  ["office-login-request.json", officeLoginRequestSchema],
  ["bootstrap-request.json", bootstrapRequestSchema],
  ["org-profile-update.json", orgProfileUpdateSchema],
  ["org-logo-put.json", orgLogoPutSchema],
  ["pallet-sheet-create.json", palletSheetCreateSchema],
  ["pallet-sheet-update.json", palletSheetUpdateSchema],
  ["pallet-sheet-default-update.json", palletSheetDefaultUpdateSchema],
  ["sscc-counter-update.json", ssccCounterUpdateSchema],
  ["block-sizes-update.json", blockSizesUpdateSchema],
  ["office-user-create.json", officeUserCreateSchema],
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
  ["counterparty-create.json", counterpartyCreateSchema],
  ["counterparty-update.json", counterpartyUpdateSchema],
  ["employee-create.json", employeeCreateSchema],
  ["employee-update.json", employeeUpdateSchema],
  ["line-create.json", lineCreateSchema],
  ["line-update.json", lineUpdateSchema],
  ["device-update.json", deviceUpdateSchema],
  ["pairing-code-request.json", pairingCodeRequestSchema],
  ["operator-create.json", operatorCreateSchema],
  ["operator-update.json", operatorUpdateSchema],
  ["badge-create.json", badgeCreateSchema],
  ["product-create.json", productCreateSchema],
  ["product-update.json", productUpdateSchema],
  ["template-create.json", templateCreateSchema],
  ["template-update.json", templateUpdateSchema],
  ["template-defaults-update.json", templateDefaultsUpdateSchema],
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
  ["shift-create.json", shiftCreateSchema],
  ["shift-create-pallets.json", shiftCreateSchema],
  ["shift-create-pallet-sheet.json", shiftCreateSchema],
  ["shift-create-validation.json", shiftCreateSchema],
  ["shift-create-validation-print.json", shiftCreateSchema],
  ["shift-enter.json", shiftEnterSchema],
  ["shift-enter-empty.json", shiftEnterSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-update-main-sheet.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
  ["shift-export-record.json", shiftExportRecordSchema],
  ["device-shift-create.json", deviceShiftCreateSchema],
  ["device-shift-create-pallets.json", deviceShiftCreateSchema],
  ["sscc-block-request.json", ssccBlockRequestSchema],
  ["facts-request.json", factBatchSchema],
  ["facts-request-pallets.json", factBatchSchema],
  ["fact-scan-validation.json", factRecordSchema],
  ["fact-unit-label-prepared.json", factRecordSchema],
  ["fact-unit-label-sent.json", factRecordSchema],
  ["fact-unit-label-verified.json", factRecordSchema],
  ["fact-unit-label-skipped.json", factRecordSchema],
  ["fact-unit-label-unknown.json", factRecordSchema],
  ["fact-unit-label-reprint.json", factRecordSchema],
] as const;

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each([
  ["office-boxes.json", officeBoxSchema],
  ["office-pallets.json", officePalletSchema],
] as const)("list fixture %s (plan ЧЗ)", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.array().parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    const rows = fixture(name) as Record<string, unknown>[];
    expect(
      schema.array().safeParse(rows.map((row) => ({ ...row, addedLater: true }))).success,
    ).toBe(true);
  });
});

describe("the office's box and pallet lists (plan ЧЗ)", () => {
  const boxes = fixture("office-boxes.json") as Record<string, unknown>[];
  const pallets = fixture("office-pallets.json") as Record<string, unknown>[];
  const box = boxes[0] as Record<string, unknown>;
  const pallet = pallets[0] as Record<string, unknown>;

  it("reads an open pallet, one taken apart, and a box taken apart, as the host writes them", () => {
    const open = {
      ...pallet,
      sscc: null,
      closedAt: null,
      boxCountReported: null,
      printVerifiedAt: null,
    };
    expect(officePalletSchema.parse(open)).toEqual(open);
    const apart = { ...pallet, disassembledAt: "2026-10-08T06:30:00.000Z", printSkippedAt: null };
    expect(officePalletSchema.parse(apart)).toEqual(apart);
    const taken = {
      ...box,
      disassembledAt: "2026-10-08T06:30:00.000Z",
      units: 0,
      digestMatches: false,
    };
    expect(officeBoxSchema.parse(taken)).toEqual(taken);
  });

  it.each([
    ["a missing digest verdict", { ...box, digestMatches: undefined }],
    ["a missing reported count", { ...box, itemCountReported: undefined }],
    ["a negative unit count", { ...box, units: -1 }],
    ["a fractional unit count", { ...box, units: 1.5 }],
    ["a device that is no UUID", { ...box, deviceId: "station" }],
    ["an opening instant that is no instant", { ...box, openedAt: "yesterday" }],
    ["a closing instant that is no instant", { ...box, closedAt: "2026-10-08" }],
    ["a taken-apart instant that is no instant", { ...box, disassembledAt: "late" }],
    ["a label instant that is no instant", { ...box, printVerifiedAt: "2026-10-08" }],
    ["a skip instant that is no instant", { ...box, printSkippedAt: "2026-10-08" }],
    ["a negative reported count", { ...box, itemCountReported: -1 }],
    ["a fractional reported count", { ...box, itemCountReported: 1.5 }],
    ["a missing pallet link", { ...box, palletId: undefined }],
  ])("refuses a box with %s", (_, row) => {
    expect(officeBoxSchema.safeParse(row).success).toBe(false);
  });

  it.each([
    ["a missing SSCC", { ...pallet, sscc: undefined }],
    ["a negative box count", { ...pallet, boxes: -1 }],
    ["a negative unit count", { ...pallet, units: -1 }],
    ["a fractional box count", { ...pallet, boxes: 0.5 }],
    ["a fractional unit count", { ...pallet, units: 1.5 }],
    ["a fractional reported count", { ...pallet, boxCountReported: 1.5 }],
    ["a reported count of zero", { ...pallet, boxCountReported: 0 }],
    ["a missing reported count", { ...pallet, boxCountReported: undefined }],
    ["a device that is no UUID", { ...pallet, deviceId: "station" }],
    ["an opening instant that is no instant", { ...pallet, openedAt: "yesterday" }],
    ["a closing instant that is no instant", { ...pallet, closedAt: "2026-10-08" }],
    ["a taken-apart instant that is no instant", { ...pallet, disassembledAt: "late" }],
    ["a skip instant that is no instant", { ...pallet, printSkippedAt: "2026-10-08" }],
    ["a check instant that is no instant", { ...pallet, printVerifiedAt: "2026-10-08" }],
  ])("refuses a pallet with %s", (_, row) => {
    expect(officePalletSchema.safeParse(row).success).toBe(false);
  });

  it("does not cap a pallet's unit count at 32 bits (the host counts them in 64)", () => {
    expect(officePalletSchema.safeParse({ ...pallet, units: 5_000_000_000 }).success).toBe(true);
  });
});

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(true);
  });
});

describe.each(REQUESTS)("request fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("rejects an unknown field, like the host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(false);
  });
});

describe("protocol 4: the shift modes (plan РЕЖ)", () => {
  const shift = officeShiftSchema.parse(fixture("office-shift.json"));
  const input = {
    productId: shift.productId,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    boxTemplateId: shift.boxTemplateId,
    boxCapacity: shift.boxCapacity,
    plannedQty: 1200,
    counterpartyId: shift.counterpartyId,
    pallets: null,
  };

  it("speaks protocol 4 and enters a shift naming what this station works", () => {
    // Protocol 4 brought the modes; 5 (part B, below) keeps them.
    expect(PROTOCOL_VERSION).toBe(5);
    expect(SHIFT_SUPPORTS).toStrictEqual({
      validation: "validation-v1",
      validationDmDuplicate: "validation-dm-duplicate-v1",
    });
    // The station of part A works validation, and says so on every entry.
    expect(STATION_SHIFT_ENTER).toStrictEqual(fixture("shift-enter.json"));
    expect(shiftEnterSchema.parse(STATION_SHIFT_ENTER)).toStrictEqual(STATION_SHIFT_ENTER);
  });

  it("bounds the capabilities an entry names", () => {
    const enter = (supports: unknown) => shiftEnterSchema.safeParse({ supports }).success;
    expect(enter([])).toBe(true);
    expect(enter(["x".repeat(64)])).toBe(true);
    expect(enter(Array.from({ length: 32 }, (_, index) => `cap-${index}`))).toBe(true);
    expect(enter([""])).toBe(false);
    expect(enter(["x".repeat(65)])).toBe(false);
    expect(enter(Array.from({ length: 33 }, (_, index) => `cap-${index}`))).toBe(false);
    expect(enter("validation-v1")).toBe(false);
    expect(enter([1])).toBe(false);
  });

  it("plans a shift in the mode the office chose, aggregation when it names none", () => {
    expect(shiftCreate({ ...input, mode: "validation" })).toStrictEqual(
      fixture("shift-create-validation.json"),
    );
    expect(shiftCreate({ ...input, mode: "aggregation" })).toStrictEqual(
      fixture("shift-create.json"),
    );
    expect(shiftCreate(input)).toStrictEqual(fixture("shift-create.json"));
  });

  it("reads a validation scan accepted without a box; whether an ok scan needs one is the host's", () => {
    const record = factRecordSchema.parse(fixture("fact-scan-validation.json"));
    expect(record.kind).toBe("scan");
    if (record.kind !== "scan") return;
    expect(record.data.verdict).toBe("ok");
    expect(record.data.boxId).toBeNull();
    // The station never leaves `boxId` out: a scan names its box or `null`.
    const withoutBox: Record<string, unknown> = { ...record.data };
    delete withoutBox["boxId"];
    expect(factRecordSchema.safeParse({ ...record, data: withoutBox }).success).toBe(false);
  });
});

// The site's badge salt: `hashBadge` embeds it verbatim, and the host refuses a
// badge hash under a salt that is not canonical (`decode_canonical` behind
// `secrets::parse_phc`): standard base64 with padding that holds exactly 16
// bytes and encodes back to the same text. The rule has three entry points, the
// response schema of `GET /v1/office/badge-salt`, the constant it is built from
// and the feed's `site` record, which carries the same value; all are held to a
// reference (`isCanonicalSalt`) that restates it.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A canonical salt whose bytes put both `+` and `/` in its base64 text. */
const SALT_WITH_PLUS_AND_SLASH = "++++////++++////++++/w==";

/**
 * The last data character of a canonical 16-byte salt: 22 characters hold 132
 * bits for 128 of data, so the last carries 2 data bits and 4 zero ones, which
 * leaves alphabet positions 0, 16, 32 and 48.
 */
const LAST_DATA_CHARACTERS = "AQgw";

/** The host's `decode_canonical` for a salt: 16 bytes that encode back to the same text. */
function isCanonicalSalt(text: string): boolean {
  try {
    const bytes = atob(text);
    return bytes.length === 16 && btoa(bytes) === text;
  } catch {
    return false;
  }
}

/** The standard base64 of the bytes 0, 1, 2 and so on: `count` of them. */
function saltOfBytes(count: number): string {
  return btoa(String.fromCharCode(...Array.from({ length: count }, (_, byte) => byte)));
}

/** A canonical salt: 16 bytes, 24 characters. */
const SALT = saltOfBytes(16);

const SALT_CHECKS = [
  ["badgeSaltSchema", (salt: string) => badgeSaltSchema.safeParse({ badgeSalt: salt }).success],
  ["canonicalSaltSchema", (salt: string) => canonicalSaltSchema.safeParse(salt).success],
  [
    "siteRecordSchema",
    (salt: string) =>
      siteRecordSchema.safeParse({ badgeSalt: salt, boxBlockSize: 2000, palletBlockSize: 200 })
        .success,
  ],
] as const;

describe.each(SALT_CHECKS)("%s takes only a canonical 16-byte salt", (_name, accepts) => {
  it("takes the salt of the fixture, and a salt with + and /", () => {
    const { badgeSalt } = fixture("badge-salt.json") as { badgeSalt: string };
    expect(accepts(badgeSalt), badgeSalt).toBe(true);
    expect(accepts(SALT_WITH_PLUS_AND_SLASH), SALT_WITH_PLUS_AND_SLASH).toBe(true);
  });

  it.each([
    ["24 characters without padding (18 bytes)", saltOfBytes(18)],
    ["23 characters and one = (17 bytes)", saltOfBytes(17)],
    ["a last data character with stray bits (x for w)", "AAECAwQFBgcICQoLDA0ODx=="],
    ["a - where the standard alphabet has a +", SALT_WITH_PLUS_AND_SLASH.replaceAll("+", "-")],
    ["a _ where the standard alphabet has a /", SALT_WITH_PLUS_AND_SLASH.replaceAll("/", "_")],
    ["15 bytes", saltOfBytes(15)],
    ["32 bytes", saltOfBytes(32)],
    ["nothing", ""],
    ["16 bytes without padding (22 characters)", SALT.slice(0, 22)],
    ["16 bytes with one = (23 characters)", SALT.slice(0, 23)],
    ["19 bytes, which end in a valid last data character (28 characters)", saltOfBytes(19)],
    ["a character in front of a canonical salt", `x${SALT}`],
    ["a character after a canonical salt", `${SALT}A`],
    ["a newline after a canonical salt", `${SALT}\n`],
  ])("refuses %s", (_what, salt) => {
    expect(accepts(salt), salt).toBe(false);
    expect(isCanonicalSalt(salt), salt).toBe(false);
  });

  it("takes A, Q, g and w as the last data character and no other", () => {
    const prefix = "AAECAwQFBgcICQoLDA0OD";
    const taken = [...BASE64_ALPHABET].filter((last) => accepts(`${prefix}${last}==`));
    expect(taken).toStrictEqual([...LAST_DATA_CHARACTERS]);
    for (const last of BASE64_ALPHABET) {
      const salt = `${prefix}${last}==`;
      expect(accepts(salt), salt).toBe(isCanonicalSalt(salt));
    }
  });

  it("agrees with the reference on 200 random salts and on each one with a stray bit", () => {
    const strays = [...BASE64_ALPHABET]
      .filter((character) => !LAST_DATA_CHARACTERS.includes(character))
      .join("");
    for (let round = 0; round < 200; round++) {
      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      expect(isCanonicalSalt(salt), salt).toBe(true);
      expect(accepts(salt), salt).toBe(true);
      const spoiled = `${salt.slice(0, 21)}${strays.charAt(round % strays.length)}==`;
      expect(isCanonicalSalt(spoiled), spoiled).toBe(false);
      expect(accepts(spoiled), spoiled).toBe(false);
    }
  });
});

// Every request body the office sends has one builder, which names each
// field (no spread from form values); each must produce its fixture exactly.
describe("request builders produce their fixtures exactly", () => {
  it("a counterparty to create and one to update", () => {
    expect(
      counterpartyCreate({
        name: "ООО «Северный берег»",
        inn: null,
        gln: "4601234000017",
        gs1Prefixes: ["4601234"],
      }),
    ).toStrictEqual(fixture("counterparty-create.json"));
    expect(
      counterpartyUpdate(
        {
          name: "ООО «Северный берег»",
          inn: "7812345678",
          gln: "4601234000017",
          gs1Prefixes: ["4601234", "4609876"],
        },
        true,
        12,
      ),
    ).toStrictEqual(fixture("counterparty-update.json"));
  });

  it("an employee to create linked to an operator, and one archived and unlinked", () => {
    const employee = employeeRecordSchema.parse(fixture("employee-record.json"));
    expect(
      employeeCreate({
        name: "Анна Кузнецова",
        role: "Упаковщик",
        operatorId: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      }),
    ).toStrictEqual(fixture("employee-create.json"));
    expect(
      employeeUpdate(employee, {
        name: "Анна Кузнецова",
        role: null,
        operatorId: null,
        archived: true,
      }),
    ).toStrictEqual(fixture("employee-update.json"));
  });

  it("a line to create and one to archive", () => {
    const line = officeLineSchema.parse(fixture("office-line.json"));
    expect(lineCreate("Линия 3")).toStrictEqual(fixture("line-create.json"));
    expect(lineUpdate(line, { name: line.name, archived: true })).toStrictEqual(
      fixture("line-update.json"),
    );
  });

  it("a station renamed and taken off its line", () => {
    const device = deviceRecordSchema.parse(fixture("device-record.json"));
    expect(deviceUpdate(device, { name: "Станция упаковки", lineId: null })).toStrictEqual(
      fixture("device-update.json"),
    );
  });

  it("a new pairing code that replaces the one on screen", () => {
    const code = pairingCodeSchema.parse(fixture("pairing-code.json"));
    expect(pairingCodeRequest(code.id)).toStrictEqual(fixture("pairing-code-request.json"));
  });

  it("an operator to create, and one to update that clears the role, turns off and gets a new PIN", () => {
    const { pinPhc } = operatorCreateSchema.parse(fixture("operator-create.json"));
    // A form holds more than the builder names: the PIN itself must not go.
    const typed = { login: "0042", name: "Анна Кузнецова", role: "Упаковщик", pinPhc, pin: "4821" };
    expect(operatorCreate(typed)).toStrictEqual(fixture("operator-create.json"));
    const operator = officeOperatorSchema.parse(fixture("office-operator.json"));
    expect(
      operatorUpdate({ ...operator, role: "Упаковщик" }, { role: null, active: false, pinPhc }),
    ).toStrictEqual(fixture("operator-update.json"));
  });

  it("a badge to add", () => {
    const { badgePhc } = badgeCreateSchema.parse(fixture("badge-create.json"));
    // The scanned code is in the form too, and must never go.
    const scanned = { badgePhc, label: "Пропуск №7", code: "MRK-000742" };
    expect(badgeCreate(scanned)).toStrictEqual(fixture("badge-create.json"));
  });

  it("a product to create, and one to update that clears the print name and archives it", () => {
    // A form holds more than the builder names: the GTIN as typed must not go.
    const typed = {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л",
      printName: "Молоко 3,2%",
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: 40,
      shelfLifeDays: 10,
      defaultBoxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      defaultPalletTemplateId: null,
      defaultPalletSheetId: null,
      gtin: "4600682000013",
    };
    expect(productCreate(typed)).toStrictEqual(fixture("product-create.json"));
    const product = officeProductSchema.parse(fixture("office-product.json"));
    expect(
      productUpdate({ ...product, printName: null, palletBoxCapacity: 48 }, true, product.rev),
    ).toStrictEqual(fixture("product-update.json"));
  });

  it("a template to create, and one to update that turns it off and adds a category", () => {
    const { spec } = templateCreateSchema.parse(fixture("template-create.json"));
    expect(
      templateCreate({
        name: "Молоко 58×40",
        purpose: "box",
        enabled: true,
        chzProductGroupCodes: null,
        spec,
      }),
    ).toStrictEqual(fixture("template-create.json"));
    const template = labelTemplateSchema.parse(fixture("label-template.json"));
    expect(
      templateUpdate(template, {
        name: template.name,
        enabled: false,
        chzProductGroupCodes: [8, 15],
      }),
    ).toStrictEqual(fixture("template-update.json"));
  });

  it("the template defaults, whole, over an older revision", () => {
    const defaults = templateDefaultsSchema.parse(fixture("template-defaults.json"));
    // The document's own `rev` is not sent: the builder names the fields it sends.
    expect(templateDefaultsUpdate(defaults, 63)).toStrictEqual(
      fixture("template-defaults-update.json"),
    );
  });

  it("a template for some categories, switched off and of another purpose, from the fields it names", () => {
    const codes = [8, 15];
    const spec = { widthMm: 100, heightMm: 150 };
    // A form holds more than the builder names: the note typed beside the name must not go.
    const typed = {
      name: "Паллета 100×150",
      purpose: "pallet",
      enabled: false,
      chzProductGroupCodes: codes,
      spec,
      note: "для склада",
    } as const;
    const body = templateCreate(typed);
    expect(body).toStrictEqual({
      name: "Паллета 100×150",
      purpose: "pallet",
      enabled: false,
      chzProductGroupCodes: [8, 15],
      spec,
    });
    // The list sent is a copy: a later change to the caller's array does not reach it.
    codes.push(3);
    expect(body.chzProductGroupCodes).toEqual([8, 15]);
  });

  it("a shift to plan, one moved to another line and day with its plan cleared, and one to close", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    // A form holds more than the builder names: the product's name must not go.
    const typed = {
      productId: shift.productId,
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: shift.boxCapacity,
      plannedQty: 1200,
      counterpartyId: shift.counterpartyId,
      pallets: null,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(shiftCreate(typed)).toStrictEqual(fixture("shift-create.json"));
    // With pallets: their capacity and template, and nothing else changes (plan О-Ф).
    expect(
      shiftCreate({
        ...typed,
        counterpartyId: null,
        pallets: { boxCapacity: 40, templateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f" },
      }),
    ).toStrictEqual(fixture("shift-create-pallets.json"));
    // Loaded on another line, moved back to the fixture's line.
    const elsewhere = { ...shift, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" };
    expect(
      shiftUpdate(elsewhere, {
        lineId: shift.lineId,
        productionDate: "2026-10-09",
        boxTemplateId: shift.boxTemplateId,
        boxCapacity: shift.boxCapacity,
        plannedQty: null,
        counterpartyId: shift.counterpartyId,
      }),
    ).toStrictEqual(fixture("shift-update.json"));
    expect(shiftClose("Станция линии 2 вышла из строя", shift.rev)).toStrictEqual(
      fixture("shift-close.json"),
    );
  });

  it("a station's new shift, with no counterparty, of which the station keeps no copy", () => {
    const shift = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));
    // The screen holds more than the builder names: the product's name must not go.
    const typed = {
      requestId: shift.requestId,
      productId: shift.productId,
      boxTemplateId: shift.boxTemplateId,
      productionDate: shift.productionDate,
      boxCapacity: 12,
      plannedQty: null,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(deviceShiftCreate(typed)).toStrictEqual(fixture("device-shift-create.json"));
    expect(deviceShiftCreate({ ...typed, plannedQty: 1200 })).toStrictEqual({
      ...shift,
      plannedQty: 1200,
    });
  });

  it("sends the capacity, the date and every id the operator chose, not the fixture's", () => {
    const chosen = {
      requestId: "11111111-2222-4333-8444-555555555555",
      productId: "66666666-7777-4888-9999-aaaaaaaaaaaa",
      boxTemplateId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      productionDate: "2026-12-31",
      boxCapacity: 24,
      plannedQty: 480,
    };
    const created = deviceShiftCreate(chosen);
    expect(created).toStrictEqual({ ...chosen, counterpartyId: null });
    // The wire body is what the host's strict body takes, field for field.
    expect(deviceShiftCreateSchema.parse(created)).toStrictEqual(created);
    expect(Object.keys(created).sort()).toStrictEqual(
      Object.keys(chosen).concat("counterpartyId").sort(),
    );
  });

  it("a station's new shift with pallets names them, their capacity and their template (plan ПЛ-Ц)", () => {
    const shift = deviceShiftCreateSchema.parse(fixture("device-shift-create-pallets.json"));
    const plain = {
      requestId: shift.requestId,
      productId: shift.productId,
      boxTemplateId: shift.boxTemplateId,
      productionDate: shift.productionDate,
      boxCapacity: 12,
      plannedQty: null,
    };
    const pallets = { boxCapacity: 40, templateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f" };
    expect(deviceShiftCreate({ ...plain, pallets })).toStrictEqual(
      fixture("device-shift-create-pallets.json"),
    );
    // The station names no A4 sheet: the host gives a station's shift the sheet
    // by the product, its category, the organization, as an office plan's.
    expect(deviceShiftCreate({ ...plain, pallets })).not.toHaveProperty("palletSheetTemplateId");
    // Without pallets, none of their fields: the host's rule for a shift without them.
    const body = deviceShiftCreate(plain);
    for (const field of ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("takes the A4 sheet in a station's request as the host does, though a station of this build names none (plan А4)", () => {
    const shift = deviceShiftCreateSchema.parse(fixture("device-shift-create-pallets.json"));
    const sheet = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
    const named = { ...shift, palletSheetTemplateId: sheet };
    expect(deviceShiftCreateSchema.parse(named)).toStrictEqual(named);
    expect(
      deviceShiftCreateSchema.safeParse({ ...shift, palletSheetTemplateId: "6" }).success,
    ).toBe(false);
    expect(
      deviceShiftCreateSchema.safeParse({ ...shift, palletSheetTemplateId: null }).success,
    ).toBe(false);
  });

  it("the record of an export names every field and sums its parts' counts (plan ЧЗ)", () => {
    const written = {
      formatId: "shift_xml_gismt_aggregation_pallets",
      formatVersion: 1,
      maxLines: null,
      palletId: null,
      documentId: "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
      parts: [{ codeCount: 3, boxCount: 2, palletCount: 1 }],
      openPalletSuppressedBoxCount: 0,
    };
    expect(shiftExportRecord(written)).toStrictEqual(fixture("shift-export-record.json"));
    expect(
      shiftExportRecord({
        ...written,
        maxLines: 7,
        parts: [
          { codeCount: 2, boxCount: 1, palletCount: 1 },
          { codeCount: 1, boxCount: 1, palletCount: 0 },
        ],
        openPalletSuppressedBoxCount: 1,
      }),
    ).toStrictEqual({
      ...(fixture("shift-export-record.json") as object),
      maxLines: 7,
      partCount: 2,
      openPalletSuppressedBoxCount: 1,
    });
  });

  it("a shift planned with no plan and no counterparty names both as null and still names the mode and pallets", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const body = shiftCreate({
      productId: shift.productId,
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: shift.boxCapacity,
      plannedQty: null,
      counterpartyId: null,
      pallets: null,
    });
    expect(body).toStrictEqual({
      productId: shift.productId,
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: 12,
      plannedQty: null,
      counterpartyId: null,
      mode: "aggregation",
      palletsEnabled: false,
    });
    expect(shiftCreateSchema.parse(body)).toStrictEqual(body);
  });

  it("template defaults that keep each slot's own template and send only the fields they name", () => {
    const box = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
    const pallet = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const duplicate = "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e";
    const categories = [
      { chzProductGroupCode: 8, purpose: "pallet", templateId: pallet },
      { chzProductGroupCode: 15, purpose: "product_duplicate", templateId: duplicate },
    ] as const;
    // A table row holds more than the entry names: its caption must not go.
    const rows = categories.map((entry) => ({ ...entry, caption: "Молочная продукция" }));
    const sheet = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
    // A sheet row holds more too; a sheet goes as a sheet, never as a template.
    const sheetRows = [{ chzProductGroupCode: 8, sheetId: sheet, caption: "Молочная продукция" }];
    expect(
      templateDefaultsUpdate(
        {
          defaultBoxTemplateId: box,
          defaultPalletTemplateId: pallet,
          defaultDuplicateTemplateId: duplicate,
          categories: rows,
          defaultPalletSheetId: sheet,
          palletSheetCategories: sheetRows,
        },
        9,
      ),
    ).toStrictEqual({
      defaultBoxTemplateId: box,
      defaultPalletTemplateId: pallet,
      defaultDuplicateTemplateId: duplicate,
      categories: [
        { chzProductGroupCode: 8, purpose: "pallet", templateId: pallet },
        { chzProductGroupCode: 15, purpose: "product_duplicate", templateId: duplicate },
      ],
      defaultPalletSheetId: sheet,
      palletSheetCategories: [{ chzProductGroupCode: 8, sheetId: sheet }],
      expectedRev: 9,
    });
    // No default at all: `null` for each slot and an empty list.
    expect(
      templateDefaultsUpdate(
        {
          defaultBoxTemplateId: null,
          defaultPalletTemplateId: null,
          defaultDuplicateTemplateId: null,
          categories: [],
          defaultPalletSheetId: null,
          palletSheetCategories: [],
        },
        9,
      ),
    ).toStrictEqual({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: [],
      defaultPalletSheetId: null,
      palletSheetCategories: [],
      expectedRev: 9,
    });
  });
});

describe("the record of an export, field by field (plan ЧЗ)", () => {
  const record = fixture("shift-export-record.json") as Record<string, unknown>;
  const written = {
    formatId: "pallet_xml_gismt_aggregation",
    formatVersion: 3,
    maxLines: 500,
    palletId: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
    documentId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    parts: [
      { codeCount: 5, boxCount: 2, palletCount: 1 },
      { codeCount: 7, boxCount: 3, palletCount: 4 },
      { codeCount: 0, boxCount: 1, palletCount: 2 },
    ],
    openPalletSuppressedBoxCount: 6,
  };

  it("carries every field of what was written through, and totals each count over all parts", () => {
    expect(shiftExportRecord(written)).toStrictEqual({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 3,
      maxLines: 500,
      palletId: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      documentId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      partCount: 3,
      codeCount: 12,
      boxCount: 6,
      palletCount: 7,
      openPalletSuppressedBoxCount: 6,
    });
    expect(shiftExportRecordSchema.safeParse(shiftExportRecord(written)).success).toBe(true);
  });

  it("names a part count of zero as it is: the host refuses it, the builder does not hide it", () => {
    expect(shiftExportRecord({ ...written, parts: [] })).toMatchObject({
      partCount: 0,
      codeCount: 0,
      boxCount: 0,
      palletCount: 0,
    });
  });

  it.each([
    ["formatId", 7],
    ["formatVersion", 1.5],
    ["maxLines", 2.5],
    ["maxLines", "100"],
    ["palletId", 5],
    ["documentId", "SEP26-003"],
    ["documentId", null],
    ["partCount", 1.5],
    ["codeCount", 3.5],
    ["codeCount", "3"],
    ["boxCount", 2.5],
    ["palletCount", 0.5],
    ["openPalletSuppressedBoxCount", 1.5],
    ["openPalletSuppressedBoxCount", null],
  ])("refuses %s = %j", (field, value) => {
    expect(shiftExportRecordSchema.safeParse({ ...record, [field]: value }).success).toBe(false);
  });

  it.each(Object.keys(record))("refuses a record with no %s", (field) => {
    const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== field));
    expect(Object.keys(rest)).toHaveLength(Object.keys(record).length - 1);
    expect(shiftExportRecordSchema.safeParse(rest).success).toBe(false);
  });

  it("takes a pallet's id, a line limit and a count above 32 bits", () => {
    expect(
      shiftExportRecordSchema.safeParse({
        ...record,
        palletId: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        maxLines: 1_000_000,
        codeCount: 5_000_000_000,
      }).success,
    ).toBe(true);
  });
});

describe("the formats of exports (plan ЧЗ)", () => {
  it("the host takes exactly the formats the domain advertises (export-formats.json)", () => {
    expect(fixture("export-formats.json")).toEqual({
      shift: SHIFT_EXPORT_FORMATS.map(({ id, version }) => ({ id, version })),
      pallet: PALLET_EXPORT_FORMATS.map(({ id, version }) => ({ id, version })),
    });
  });
});

describe("request builders send only what changes", () => {
  const LINE = { name: "Линия 2", archived: false, rev: 40 };
  const STATION = {
    kind: "station",
    name: "Станция на линии 2",
    lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  } as const;

  it("names only the line fields that differ from the loaded line", () => {
    expect(lineUpdate(LINE, { name: "Линия 2", archived: false })).toStrictEqual({
      expectedRev: 40,
    });
    expect(lineUpdate(LINE, { name: "Линия 2а", archived: false })).toStrictEqual({
      name: "Линия 2а",
      expectedRev: 40,
    });
    expect(
      lineUpdate({ ...LINE, archived: true }, { name: "Линия 5", archived: false }),
    ).toStrictEqual({ name: "Линия 5", archived: false, expectedRev: 40 });
  });

  it("names only the device fields that differ, and a line only for a station", () => {
    expect(
      deviceUpdate(STATION, { name: "Станция на линии 2", lineId: STATION.lineId }),
    ).toStrictEqual({});
    expect(deviceUpdate(STATION, { name: "Упаковка", lineId: STATION.lineId })).toStrictEqual({
      name: "Упаковка",
    });
    const other = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    expect(deviceUpdate(STATION, { name: STATION.name, lineId: other })).toStrictEqual({
      lineId: other,
    });
    expect(
      deviceUpdate({ kind: "office", name: "Офис", lineId: null }, { name: "Офис", lineId: other }),
    ).toStrictEqual({});
  });

  it("names only the operator fields that differ, clears a role with null and always sends a new PIN", () => {
    const anna = { name: "Анна Кузнецова", role: "Упаковщик", active: true, rev: 55 };
    const pinPhc = "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$new";
    expect(operatorUpdate(anna, { name: "Анна Кузнецова", role: "Упаковщик" })).toStrictEqual({
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { name: "Анна Петрова", role: "Упаковщик" })).toStrictEqual({
      name: "Анна Петрова",
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { name: "Анна Кузнецова", role: null })).toStrictEqual({
      role: null,
      expectedRev: 55,
    });
    expect(operatorUpdate({ ...anna, role: null }, { role: "Наладчик" })).toStrictEqual({
      role: "Наладчик",
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { active: false })).toStrictEqual({
      active: false,
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { active: true })).toStrictEqual({ expectedRev: 55 });
    // Turned off, then on again: the change to `true` goes as well.
    expect(operatorUpdate({ ...anna, active: false }, { active: true })).toStrictEqual({
      active: true,
      expectedRev: 55,
    });
    // An operator with no role, renamed: `role: null` over `null` is no change.
    expect(
      operatorUpdate({ ...anna, role: null }, { name: "Анна Петрова", role: null }),
    ).toStrictEqual({ name: "Анна Петрова", expectedRev: 55 });
    expect(operatorUpdate({ ...anna, role: null }, { name: anna.name, role: null })).toStrictEqual({
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { pinPhc })).toStrictEqual({ pinPhc, expectedRev: 55 });
  });

  it("names only the template fields that differ, with three states for the categories", () => {
    const template = { name: "Молоко 58×40", enabled: true, chzProductGroupCodes: [8], rev: 62 };
    const everyCategory = { ...template, chzProductGroupCodes: null };
    // Left out: kept. The same list: no change.
    expect(templateUpdate(template, {})).toStrictEqual({ expectedRev: 62 });
    expect(
      templateUpdate(template, { name: "Молоко 58×40", enabled: true, chzProductGroupCodes: [8] }),
    ).toStrictEqual({ expectedRev: 62 });
    // `null`: every category; a list: those, in the order given.
    expect(templateUpdate(template, { chzProductGroupCodes: null })).toStrictEqual({
      chzProductGroupCodes: null,
      expectedRev: 62,
    });
    expect(templateUpdate(everyCategory, { chzProductGroupCodes: [15] })).toStrictEqual({
      chzProductGroupCodes: [15],
      expectedRev: 62,
    });
    expect(templateUpdate(everyCategory, { chzProductGroupCodes: null })).toStrictEqual({
      expectedRev: 62,
    });
    expect(
      templateUpdate(
        { ...template, chzProductGroupCodes: [8, 15] },
        { chzProductGroupCodes: [15, 8] },
      ),
    ).toStrictEqual({ chzProductGroupCodes: [15, 8], expectedRev: 62 });
    expect(templateUpdate(template, { name: "Молоко 58×40 (2)", enabled: false })).toStrictEqual({
      name: "Молоко 58×40 (2)",
      enabled: false,
      expectedRev: 62,
    });
    // A layout goes whenever it is given.
    const spec = { widthMm: 58, heightMm: 40 };
    expect(templateUpdate(template, { spec })).toStrictEqual({ spec, expectedRev: 62 });
  });

  it("calls a narrower or a wider category list a change, and sends a copy of the list", () => {
    const template = {
      name: "Молоко 58×40",
      enabled: true,
      chzProductGroupCodes: [8, 15],
      rev: 62,
    };
    // The shorter list is the front of the loaded one: still a change.
    expect(templateUpdate(template, { chzProductGroupCodes: [8] })).toStrictEqual({
      chzProductGroupCodes: [8],
      expectedRev: 62,
    });
    expect(
      templateUpdate({ ...template, chzProductGroupCodes: [8] }, { chzProductGroupCodes: [8, 15] }),
    ).toStrictEqual({ chzProductGroupCodes: [8, 15], expectedRev: 62 });
    // The list sent is a copy: a later change to the caller's array does not reach it.
    const codes = [15];
    const body = templateUpdate(
      { ...template, chzProductGroupCodes: null },
      { chzProductGroupCodes: codes },
    );
    codes.push(3);
    expect(body.chzProductGroupCodes).toEqual([15]);
  });

  it("builds only bodies the update schema takes: nothing, one field or all of them", () => {
    const template = { name: "Молоко 58×40", enabled: true, chzProductGroupCodes: [8], rev: 62 };
    const spec = { widthMm: 58, heightMm: 40 };
    const bodies = [
      templateUpdate(template, {}),
      templateUpdate(template, { name: "Молоко 58×40 (2)" }),
      templateUpdate(template, { enabled: false }),
      templateUpdate(template, { chzProductGroupCodes: null }),
      templateUpdate(template, { chzProductGroupCodes: [15] }),
      templateUpdate(template, { spec }),
      templateUpdate(template, {
        name: "Молоко 58×40 (2)",
        enabled: false,
        chzProductGroupCodes: [15],
        spec,
      }),
    ];
    for (const body of bodies) {
      expect(templateUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  it("names only the shift fields that differ, clears a plan or a counterparty with null and never sends null elsewhere", () => {
    const shift = {
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      productionDate: "2026-10-08",
      boxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
      palletsEnabled: false,
      palletBoxCapacity: null,
      palletTemplateId: null,
      palletSheetTemplateId: null,
      mode: "aggregation" as const,
      rev: 71,
    };
    const same = {
      lineId: shift.lineId,
      productionDate: shift.productionDate,
      boxTemplateId: shift.boxTemplateId,
      boxCapacity: shift.boxCapacity,
      plannedQty: shift.plannedQty,
      counterpartyId: shift.counterpartyId,
    };
    const other = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    const bodies = [
      [shiftUpdate(shift, {}), { expectedRev: 71 }],
      [shiftUpdate(shift, same), { expectedRev: 71 }],
      [shiftUpdate(shift, { ...same, lineId: other }), { lineId: other, expectedRev: 71 }],
      [
        shiftUpdate(shift, { ...same, productionDate: "2026-10-09" }),
        { productionDate: "2026-10-09", expectedRev: 71 },
      ],
      [
        shiftUpdate(shift, { ...same, boxTemplateId: other }),
        { boxTemplateId: other, expectedRev: 71 },
      ],
      [shiftUpdate(shift, { ...same, boxCapacity: 24 }), { boxCapacity: 24, expectedRev: 71 }],
      // The mode (plan РЕЖ) goes only when it changes.
      [shiftUpdate(shift, { ...same, mode: "aggregation" }), { expectedRev: 71 }],
      [
        shiftUpdate(shift, { ...same, mode: "validation" }),
        { mode: "validation", expectedRev: 71 },
      ],
      [shiftUpdate(shift, { ...same, plannedQty: 1500 }), { plannedQty: 1500, expectedRev: 71 }],
      [shiftUpdate(shift, { ...same, plannedQty: null }), { plannedQty: null, expectedRev: 71 }],
      [
        shiftUpdate(shift, { ...same, counterpartyId: null }),
        { counterpartyId: null, expectedRev: 71 },
      ],
      // No plan and no counterparty, given one: the change goes.
      [
        shiftUpdate(
          { ...shift, plannedQty: null, counterpartyId: null },
          { plannedQty: 800, counterpartyId: other },
        ),
        { plannedQty: 800, counterpartyId: other, expectedRev: 71 },
      ],
      // `null` over `null` is no change.
      [
        shiftUpdate(
          { ...shift, plannedQty: null, counterpartyId: null },
          {
            plannedQty: null,
            counterpartyId: null,
          },
        ),
        { expectedRev: 71 },
      ],
    ] as const;
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  // Added by the task 8 implementer: a shift without pallets keeps the body it always had.
  it("sends a shift without pallets the body it always had, and names the pallet fields only for a shift with pallets (plan О-Ф)", () => {
    const fixtureText = (name: string) => JSON.stringify(fixture(name));
    const input = {
      productId: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      productionDate: "2026-10-08",
      boxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
      pallets: null,
    };
    const without = shiftCreate(input);
    expect(Object.keys(without)).toEqual([
      "productId",
      "lineId",
      "productionDate",
      "boxTemplateId",
      "boxCapacity",
      "plannedQty",
      "counterpartyId",
      "mode",
      "palletsEnabled",
    ]);
    expect(JSON.stringify(without)).toBe(fixtureText("shift-create.json"));
    expect(shiftCreateSchema.parse(without)).toStrictEqual(without);
    const template = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
    const withPallets = shiftCreate({
      ...input,
      counterpartyId: null,
      pallets: { boxCapacity: 40, templateId: template },
    });
    expect(shiftCreateSchema.parse(withPallets)).toStrictEqual(withPallets);
    expect(JSON.stringify(withPallets)).toBe(fixtureText("shift-create-pallets.json"));
    // The A4 sheet (plan А4) goes only when the form chose one.
    const withSheet = shiftCreate({
      ...input,
      counterpartyId: null,
      pallets: {
        boxCapacity: 40,
        templateId: template,
        sheetId: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
      },
    });
    expect(JSON.stringify(withSheet)).toBe(fixtureText("shift-create-pallet-sheet.json"));
    expect(shiftCreateSchema.parse(withSheet)).toStrictEqual(withSheet);
    expect(withPallets).not.toHaveProperty("palletSheetTemplateId");
    expect(shiftCreateSchema.safeParse({ ...withSheet, palletSheetTemplateId: "6" }).success).toBe(
      false,
    );
    // An edit of something else names no pallet field, with pallets or without.
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const enabled = {
      ...shift,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: template,
    };
    for (const current of [shift, enabled]) {
      const body = shiftUpdate(current, { plannedQty: 7 });
      expect(Object.keys(body).sort()).toEqual(["expectedRev", "plannedQty"]);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  it("turns a shift's pallets on with their capacity and template, changes either alone, and turns them off by the switch alone (plan О-Ф)", () => {
    const template = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
    const other = "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e";
    const without = officeShiftSchema.parse(fixture("office-shift.json"));
    const withPallets = {
      ...without,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: template,
    };
    const bodies = [
      [
        shiftUpdate(without, { pallets: { boxCapacity: 40, templateId: template } }),
        {
          palletsEnabled: true,
          palletBoxCapacity: 40,
          palletTemplateId: template,
          expectedRev: 71,
        },
      ],
      [shiftUpdate(without, { pallets: null }), { expectedRev: 71 }],
      [shiftUpdate(withPallets, { pallets: null }), { palletsEnabled: false, expectedRev: 71 }],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 40, templateId: template } }),
        { expectedRev: 71 },
      ],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 32, templateId: template } }),
        { palletBoxCapacity: 32, expectedRev: 71 },
      ],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 40, templateId: other } }),
        { palletTemplateId: other, expectedRev: 71 },
      ],
      [shiftUpdate(withPallets, {}), { expectedRev: 71 }],
    ] as const;
    // The A4 sheet (plan А4): named when chosen and different, never when the
    // form leaves it to the default, and pallets turned on can carry it.
    const sheet = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
    const sheeted = { ...withPallets, palletSheetTemplateId: sheet };
    const keep = { boxCapacity: 40, templateId: template };
    const sheetBodies = [
      [
        shiftUpdate(withPallets, { pallets: { ...keep, sheetId: sheet } }),
        { palletSheetTemplateId: sheet, expectedRev: 71 },
      ],
      [shiftUpdate(sheeted, { pallets: { ...keep, sheetId: sheet } }), { expectedRev: 71 }],
      [shiftUpdate(sheeted, { pallets: keep }), { expectedRev: 71 }],
      [
        shiftUpdate(sheeted, { pallets: { ...keep, sheetId: other } }),
        { palletSheetTemplateId: other, expectedRev: 71 },
      ],
      [
        shiftUpdate(without, { pallets: { ...keep, sheetId: sheet } }),
        {
          palletsEnabled: true,
          palletBoxCapacity: 40,
          palletTemplateId: template,
          palletSheetTemplateId: sheet,
          expectedRev: 71,
        },
      ],
      [shiftUpdate(sheeted, { pallets: null }), { palletsEnabled: false, expectedRev: 71 }],
      // «Основной лист» (`null`): sent back by a shift that holds a sheet,
      // nothing from one that holds none, and pallets turned on leave it out.
      [
        shiftUpdate(sheeted, { pallets: { ...keep, sheetId: null } }),
        { palletSheetTemplateId: null, expectedRev: 71 },
      ],
      [shiftUpdate(withPallets, { pallets: { ...keep, sheetId: null } }), { expectedRev: 71 }],
      [
        shiftUpdate(without, { pallets: { ...keep, sheetId: null } }),
        {
          palletsEnabled: true,
          palletBoxCapacity: 40,
          palletTemplateId: template,
          expectedRev: 71,
        },
      ],
    ] as const;
    expect(
      shiftUpdate({ ...sheeted, rev: 72 }, { pallets: { ...keep, sheetId: null } }),
    ).toStrictEqual(fixture("shift-update-main-sheet.json"));
    expect(
      shiftCreate({
        productId: without.productId,
        lineId: without.lineId,
        productionDate: without.productionDate,
        boxTemplateId: without.boxTemplateId,
        boxCapacity: without.boxCapacity,
        plannedQty: null,
        counterpartyId: null,
        pallets: { ...keep, sheetId: null },
      }),
    ).not.toHaveProperty("palletSheetTemplateId");
    for (const [body, expected] of sheetBodies) {
      expect(body).toStrictEqual(expected);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  it("copies the prefix list rather than handing over the caller's array", () => {
    const gs1Prefixes = ["4601234"];
    const body = counterpartyCreate({
      name: "ООО «Юг»",
      inn: null,
      gln: "4601234000017",
      gs1Prefixes,
    });
    gs1Prefixes.push("4609876");
    expect(body.gs1Prefixes).toEqual(["4601234"]);
  });
});

describe("catalog feed records, which grant no access", () => {
  const TEMPLATE = feedRecord("changes-catalog.json", 1);
  const ORG = feedRecord("changes-catalog.json", 2);
  const CATEGORY_DEFAULT = feedRecord("changes-catalog.json", 3);
  const PRODUCT = feedRecord("changes-catalog.json", 4);

  it("drop a key a newer host adds, as the organization's and the lines' records do", () => {
    expect(productRecordSchema.parse({ ...PRODUCT, addedLater: true })).toEqual(PRODUCT);
    expect(labelTemplateRecordSchema.parse({ ...TEMPLATE, addedLater: true })).toEqual(TEMPLATE);
    expect(categoryTemplateDefaultSchema.parse({ ...CATEGORY_DEFAULT, addedLater: true })).toEqual(
      CATEGORY_DEFAULT,
    );
  });

  it("refuse a value no station can use: a GTIN of other than 14 digits, an unknown purpose or status, a template id that is no UUID", () => {
    for (const product of [
      { ...PRODUCT, gtin14: "4600682000013" },
      { ...PRODUCT, status: "blocked" },
      { ...PRODUCT, defaultBoxTemplateId: "7" },
    ]) {
      expect(productRecordSchema.safeParse(product).success).toBe(false);
    }
    expect(labelTemplateRecordSchema.safeParse({ ...TEMPLATE, purpose: "case" }).success).toBe(
      false,
    );
    expect(labelTemplateRecordSchema.safeParse({ ...TEMPLATE, spec: [] }).success).toBe(false);
    expect(
      categoryTemplateDefaultSchema.safeParse({ ...CATEGORY_DEFAULT, templateId: "7" }).success,
    ).toBe(false);
  });

  it("read an organization record without its default templates, from a host before plan 1e1, as none", () => {
    const older = Object.fromEntries(
      Object.entries(ORG).filter(([key]) => !key.endsWith("TemplateId")),
    );
    expect(Object.keys(older)).toHaveLength(5);
    expect(orgRecordSchema.parse(older)).toEqual(older);
    expect(orgRecordSchema.safeParse({ ...ORG, defaultBoxTemplateId: "7" }).success).toBe(false);
  });

  it("read each of the organization's default templates as a UUID, as null or as absent, and refuse another text", () => {
    const TEMPLATE_ID = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
    const keys = [
      "defaultBoxTemplateId",
      "defaultPalletTemplateId",
      "defaultDuplicateTemplateId",
    ] as const;
    for (const key of keys) {
      const others = Object.fromEntries(Object.entries(ORG).filter(([name]) => name !== key));
      expect(orgRecordSchema.parse({ ...others, [key]: TEMPLATE_ID })[key], key).toBe(TEMPLATE_ID);
      expect(orgRecordSchema.parse({ ...others, [key]: null })[key], key).toBeNull();
      expect(orgRecordSchema.parse(others)[key], key).toBeUndefined();
      expect(orgRecordSchema.safeParse({ ...others, [key]: "7" }).success, key).toBe(false);
    }
  });

  it("refuse a wrong type, a negative or fractional number and a GTIN of other than 14 digits in any field of a product, a template or a category default", () => {
    const cases: Array<{
      schema: { safeParse: (value: unknown) => { success: boolean } };
      record: Record<string, unknown>;
      refused: Record<string, unknown[]>;
    }> = [
      {
        schema: productRecordSchema,
        record: PRODUCT,
        refused: {
          // The host keeps 14 digits and a scan finds a product by exactly those.
          gtin14: [
            "",
            "4600682000013",
            "046006820000130",
            "0460068200001A",
            " 04600682000013",
            "04600682000013\n",
            7,
            null,
          ],
          name: [7, null],
          printName: [7],
          chzProductGroupCode: ["8", -1, 1.5],
          boxCapacity: ["12", -1, 1.5],
          palletBoxCapacity: ["40", -1, 1.5],
          shelfLifeDays: ["10", -1, 1.5],
          defaultBoxTemplateId: [7, "7"],
          defaultPalletTemplateId: [7, "7"],
          archived: ["false", 0, null],
          status: ["blocked", 1, null],
        },
      },
      {
        schema: labelTemplateRecordSchema,
        record: TEMPLATE,
        refused: {
          name: [7, null],
          purpose: ["case", 7],
          enabled: ["true", 1, null],
          chzProductGroupCodes: ["8", [-1], [1.5], ["8"]],
          stock: ["false", 0, null],
          spec: [[], null, "layout", 7],
        },
      },
      {
        schema: categoryTemplateDefaultSchema,
        record: CATEGORY_DEFAULT,
        refused: {
          chzProductGroupCode: ["8", -1, 1.5, null],
          purpose: ["case", 7],
          templateId: ["7", 7, null],
        },
      },
    ];
    for (const { schema, record, refused } of cases) {
      for (const [field, values] of Object.entries(refused)) {
        for (const value of values) {
          const result = schema.safeParse({ ...record, [field]: value });
          expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
        }
      }
    }
  });

  it("keep a product whose GTIN has a wrong check digit: the host stores 14 digits, and the station keeps what the host keeps", () => {
    const parsed = productRecordSchema.parse({ ...PRODUCT, gtin14: "00000000000001" });
    expect(parsed.gtin14).toBe("00000000000001");
  });
});

describe("catalog shapes", () => {
  it("read a template-is-default refusal with the defaults the change would break", () => {
    const body = errorBodySchema.parse(fixture("error-template-is-default.json"));
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({
      constraint: "template_is_default",
      organizationDefault: true,
      categoryDefaults: [8, 15],
    });
  });

  it("read a summary whose layout has no size, resolution or language, or a fractional size", () => {
    const summary = labelTemplateSummarySchema.parse(fixture("template-summary.json"));
    const bare = { ...summary, widthMm: null, heightMm: null, dpi: null, language: null };
    expect(labelTemplateSummarySchema.parse(bare)).toEqual(bare);
    const fractional = { ...summary, widthMm: 58.5, heightMm: 39.75 };
    expect(labelTemplateSummarySchema.parse(fractional)).toEqual(fractional);
    expect(labelTemplateSummarySchema.safeParse({ ...summary, dpi: 203.5 }).success).toBe(false);
  });

  it("read a layout as an opaque object: any keys, never an array, a scalar or nothing", () => {
    const layout = { "10": "ten", widthMm: 58, elements: [{ kind: "field", id: "name" }] };
    expect(templateSpecSchema.parse(layout)).toBe(layout);
    expect(templateSpecSchema.safeParse({}).success).toBe(true);
    for (const value of [[], "{}", 58, null, undefined]) {
      expect(templateSpecSchema.safeParse(value).error?.issues.map((issue) => issue.code)).toEqual([
        "custom",
      ]);
    }
  });

  it("refuse null that the host would ignore (a template's name, flag and layout) or refuse (orgDefault, templates)", () => {
    for (const field of ["name", "enabled", "spec"]) {
      expect(templateUpdateSchema.safeParse({ [field]: null, expectedRev: 62 }).success).toBe(
        false,
      );
    }
    expect(
      templateUpdateSchema.safeParse({ chzProductGroupCodes: null, expectedRev: 62 }).success,
    ).toBe(true);
    const request = bootstrapRequestSchema.parse(fixture("bootstrap-request-templates.json"));
    const [stock] = request.templates ?? [];
    expect(stockTemplateSchema.safeParse({ ...stock, orgDefault: null }).success).toBe(false);
    expect(bootstrapRequestSchema.safeParse({ ...request, templates: null }).success).toBe(false);
  });

  it("read a draft product, and refuse an unknown status, a count that is no whole number or an id that is no UUID", () => {
    const product = officeProductSchema.parse(fixture("office-product.json"));
    // Before it has a group and both capacities a product is a draft, and all of them are blank.
    const draft = {
      ...product,
      printName: null,
      chzProductGroupCode: null,
      boxCapacity: null,
      palletBoxCapacity: null,
      shelfLifeDays: null,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      status: "draft",
    };
    expect(officeProductSchema.parse(draft)).toEqual(draft);
    expect(officeProductSchema.safeParse({ ...product, status: "archived" }).success).toBe(false);
    for (const field of [
      "chzProductGroupCode",
      "boxCapacity",
      "palletBoxCapacity",
      "shelfLifeDays",
    ]) {
      for (const value of [12.5, -1]) {
        const result = officeProductSchema.safeParse({ ...product, [field]: value });
        expect(result.success, `${field} ${value}`).toBe(false);
      }
    }
    for (const field of ["id", "defaultBoxTemplateId", "defaultPalletTemplateId"]) {
      expect(officeProductSchema.safeParse({ ...product, [field]: "42" }).success, field).toBe(
        false,
      );
    }
  });

  it("read a template for every category, and refuse an unknown purpose, an id that is no UUID, a group code that is no whole number or a negative resolution", () => {
    const template = labelTemplateSchema.parse(fixture("label-template.json"));
    const summary = labelTemplateSummarySchema.parse(fixture("template-summary.json"));
    // A stock template, the wizard's, is for every category: `null`, not a list.
    const stockTemplate = { ...template, chzProductGroupCodes: null, stock: true };
    expect(labelTemplateSchema.parse(stockTemplate)).toEqual(stockTemplate);
    const stockSummary = { ...summary, chzProductGroupCodes: null, stock: true };
    expect(labelTemplateSummarySchema.parse(stockSummary)).toEqual(stockSummary);
    for (const [schema, value] of [
      [labelTemplateSchema, template],
      [labelTemplateSummarySchema, summary],
    ] as const) {
      expect(schema.safeParse({ ...value, purpose: "sticker" }).success).toBe(false);
      expect(schema.safeParse({ ...value, id: "42" }).success).toBe(false);
      for (const code of [8.5, -8]) {
        const result = schema.safeParse({ ...value, chzProductGroupCodes: [code] });
        expect(result.success, `${code}`).toBe(false);
      }
    }
    expect(labelTemplateSummarySchema.safeParse({ ...summary, dpi: -203 }).success).toBe(false);
  });

  it("read the template defaults when none is set and when every slot has one, and refuse a bad entry", () => {
    const defaults = templateDefaultsSchema.parse(fixture("template-defaults.json"));
    const none = {
      ...defaults,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: [],
    };
    expect(templateDefaultsSchema.parse(none)).toEqual(none);
    const every = {
      ...defaults,
      defaultBoxTemplateId: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
      defaultPalletTemplateId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      defaultDuplicateTemplateId: "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e",
    };
    expect(templateDefaultsSchema.parse(every)).toEqual(every);
    const [entry] = defaults.categories;
    for (const bad of [{ purpose: "sticker" }, { templateId: "42" }, { chzProductGroupCode: -8 }]) {
      const result = templateDefaultsSchema.safeParse({
        ...defaults,
        categories: [{ ...entry, ...bad }],
      });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuse an unknown key inside a stock template or a category default, and a stock layout that is no object", () => {
    const request = bootstrapRequestSchema.parse(fixture("bootstrap-request-templates.json"));
    const [stock] = request.templates ?? [];
    expect(stockTemplateSchema.safeParse(stock).success).toBe(true);
    expect(stockTemplateSchema.safeParse({ ...stock, addedLater: true }).success).toBe(false);
    for (const spec of [[], "{}", null]) {
      expect(stockTemplateSchema.safeParse({ ...stock, spec }).success).toBe(false);
    }
    const defaults = templateDefaultsUpdateSchema.parse(fixture("template-defaults-update.json"));
    const [entry] = defaults.categories;
    const withExtra = { ...defaults, categories: [{ ...entry, addedLater: true }] };
    expect(templateDefaultsUpdateSchema.safeParse(withExtra).success).toBe(false);
    // A category's sheet is a code and a sheet: no purpose, nothing more.
    const [sheet] = defaults.palletSheetCategories;
    for (const bad of [{ purpose: "pallet" }, { sheetId: "42" }, { chzProductGroupCode: -8 }]) {
      const result = templateDefaultsUpdateSchema.safeParse({
        ...defaults,
        palletSheetCategories: [{ ...sheet, ...bad }],
      });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("read a document and a product from a host before the sheet defaults as having none", () => {
    const older = { ...(fixture("template-defaults.json") as Record<string, unknown>) };
    delete older["defaultPalletSheetId"];
    delete older["palletSheetCategories"];
    const read = templateDefaultsSchema.parse(older);
    expect([read.defaultPalletSheetId, read.palletSheetCategories]).toStrictEqual([null, []]);
    const product = { ...(fixture("office-product.json") as Record<string, unknown>) };
    delete product["defaultPalletSheetId"];
    expect(officeProductSchema.parse(product).defaultPalletSheetId).toBeNull();
  });

  it("whole bodies name every field: leave one out and the schema refuses", () => {
    for (const [name, schema] of [
      ["product-create.json", productCreateSchema],
      ["product-update.json", productUpdateSchema],
      ["template-create.json", templateCreateSchema],
      ["template-defaults-update.json", templateDefaultsUpdateSchema],
    ] as const) {
      const body = schema.parse(fixture(name));
      for (const key of Object.keys(body)) {
        const without = Object.fromEntries(Object.entries(body).filter(([field]) => field !== key));
        expect(schema.safeParse(without).success, `${name} without ${key}`).toBe(false);
      }
    }
  });
});

describe("shift shapes", () => {
  it("read a station's shift with pallets: their capacity, their template and its frozen layout (plan ПЛ-Ц)", () => {
    const entered = enteredShiftSchema.parse(fixture("device-shift-entered-pallets.json"));
    expect(entered).toMatchObject({
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
      snapshot: { palletTemplate: { rev: 63, spec: { widthMm: 100 } } },
    });
    // A shift without pallets names neither field (protocol 3 keeps
    // `device-shifts.json` as it was), and its snapshot has no pallet template.
    const [listed] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
    expect(listed).not.toHaveProperty("palletBoxCapacity");
    expect(listed).not.toHaveProperty("palletTemplateId");
    for (const palletBoxCapacity of [0, 1.5, "40"]) {
      expect(enteredShiftSchema.safeParse({ ...entered, palletBoxCapacity }).success).toBe(false);
    }
    expect(enteredShiftSchema.safeParse({ ...entered, palletTemplateId: "42" }).success).toBe(
      false,
    );
  });

  it("read the A4 sheet and the organization a shift froze, tolerate a snapshot without them and refuse a malformed one (plan А4)", () => {
    const entered = enteredShiftSchema.parse(fixture("device-shift-entered-sheet.json"));
    expect(entered.snapshot.palletSheet).toMatchObject({
      id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
      revision: 1,
      spec: { schemaVersion: 2, kind: "pallet_sheet", dpi: 300 },
    });
    expect(entered.snapshot.organization).toStrictEqual({
      name: "ООО «Молочный завод»",
      inn: "7701234567",
      logo: { width: 10, height: 2, pixelsBase64: "8MAPQA==" },
    });
    // The snapshot of a host before plan А4 has neither.
    const old = enteredShiftSchema.parse(fixture("device-shift-entered-pallets.json"));
    expect(old.snapshot.palletSheet).toBeUndefined();
    expect(old.snapshot.organization).toBeUndefined();
    const withOrganization = (organization: unknown) => ({
      ...entered,
      snapshot: { ...entered.snapshot, organization },
    });
    const withSheet = (palletSheet: unknown) => ({
      ...entered,
      snapshot: { ...entered.snapshot, palletSheet },
    });
    expect(
      enteredShiftSchema.safeParse(withOrganization({ name: "О", inn: null, logo: null })).success,
    ).toBe(true);
    for (const organization of [
      { name: "О", inn: null },
      { name: "О", logo: null },
      { inn: null, logo: null },
      { name: "О", inn: 7, logo: null },
      { name: "О", inn: null, logo: { width: 1.5, height: 2, pixelsBase64: "AA==" } },
      { name: "О", inn: null, logo: { width: 8, height: 2 } },
    ]) {
      expect(enteredShiftSchema.safeParse(withOrganization(organization)).success).toBe(false);
    }
    const sheet = entered.snapshot.palletSheet;
    for (const palletSheet of [
      { ...sheet, id: "42" },
      { ...sheet, revision: 0 },
      { ...sheet, name: 7 },
      { id: sheet?.id, name: "Лист", revision: 1 },
    ]) {
      const parsed = enteredShiftSchema.safeParse(withSheet(palletSheet));
      expect(parsed.success).toBe(false);
    }
    // The office's shift names its sheet or `null`, never nothing.
    const office = officeShiftSchema.parse(fixture("office-shift.json"));
    expect(office.palletSheetTemplateId).toBeNull();
    const bare = Object.fromEntries(
      Object.entries(office).filter(([key]) => key !== "palletSheetTemplateId"),
    );
    expect(officeShiftSchema.safeParse(bare).success).toBe(false);
    expect(officeShiftSchema.safeParse({ ...office, palletSheetTemplateId: "x" }).success).toBe(
      false,
    );
  });

  it("read a planned shift without a plan, a counterparty, an owner or times, and a closed one", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const planned = {
      ...shift,
      status: "planned",
      counterpartyId: null,
      plannedQty: null,
      ownerDeviceId: null,
      openedAt: null,
    };
    expect(officeShiftSchema.parse(planned)).toEqual(planned);
    const closed = {
      ...shift,
      status: "closed",
      createdFrom: "station",
      number: "OCT26-005/S",
      closedAt: "2026-10-08T14:00:00Z",
      closeReasonCode: "equipment_stop",
      lateDataAt: "2026-10-08T14:30:00Z",
    };
    expect(officeShiftSchema.parse(closed)).toEqual(closed);
  });

  it("refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive whole number and a date of another form", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const refused: Record<string, unknown[]> = {
      status: ["open", null],
      mode: ["boxes", null],
      createdFrom: ["admin", null],
      id: ["42"],
      productId: ["42", null],
      lineId: ["42", null],
      boxTemplateId: ["42", null],
      counterpartyId: ["42"],
      ownerDeviceId: ["42"],
      plannedQty: [0, 1.5, -1, "1200"],
      boxCapacity: [0, 1.5, null],
      palletBoxCapacity: [0, 1.5, -1, "40"],
      palletTemplateId: ["42"],
      productionDate: ["08.10.2026", "2026-10-8", 20261008, null],
      openedAt: ["yesterday"],
      rev: [1.5, null],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = officeShiftSchema.safeParse({ ...shift, [field]: value });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it("refuse null in a shift's update where the host would read it as keep, and take it for the plan and the counterparty", () => {
    for (const field of [
      "lineId",
      "productionDate",
      "boxTemplateId",
      "boxCapacity",
      "mode",
      "palletsEnabled",
    ]) {
      expect(shiftUpdateSchema.safeParse({ [field]: null, expectedRev: 71 }).success, field).toBe(
        false,
      );
    }
    for (const field of ["plannedQty", "counterpartyId"]) {
      expect(shiftUpdateSchema.safeParse({ [field]: null, expectedRev: 71 }).success, field).toBe(
        true,
      );
    }
  });

  it("read a shift with pallets: their capacity and their template", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const pallets = {
      ...shift,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    };
    expect(officeShiftSchema.parse(pallets)).toEqual(pallets);
  });

  it("read a shift's pallets in its totals and refuse a count of pallets that is no whole number", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const counted = { ...shift, totals: { ...shift.totals, closedPallets: 12, openPallets: 1 } };
    expect(officeShiftSchema.parse(counted)).toEqual(counted);
    for (const field of ["closedPallets", "openPallets"]) {
      for (const value of [-1, 1.5, "1", null]) {
        const totals = { ...shift.totals, [field]: value };
        expect(officeShiftSchema.safeParse({ ...shift, totals }).success, field).toBe(false);
      }
      const totals = Object.fromEntries(
        Object.entries(shift.totals).filter(([key]) => key !== field),
      );
      expect(officeShiftSchema.safeParse({ ...shift, totals }).success, field).toBe(false);
    }
  });

  it("read a mode and a close reason code this build does not know, and a plan of one unit", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const later = {
      ...shift,
      mode: "validation",
      plannedQty: 1,
      status: "closed",
      closedAt: "2026-10-08T14:00:00Z",
      closeReasonCode: "a_code_a_newer_host_adds",
      closeReasonText: "Станция линии 2 вышла из строя",
      lateDataAt: "2026-10-08T14:30:00Z",
    };
    expect(officeShiftSchema.parse(later)).toEqual(later);
  });

  it("refuse a shift whose times, number, flag, reason or date are of another form", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const refused: Record<string, unknown[]> = {
      number: ["", 4, null],
      palletsEnabled: ["no", 0, null],
      closedAt: ["yesterday", 20261008],
      lateDataAt: ["yesterday", 20261008],
      createdAt: ["yesterday", null],
      closeReasonCode: [5],
      closeReasonText: [5],
      // The date is exactly `YYYY-MM-DD`, with nothing before or after it.
      productionDate: ["2026-10-08 ", " 2026-10-08", "x2026-10-08", "2026-10-08T00:00:00Z"],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = officeShiftSchema.safeParse({ ...shift, [field]: value });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    for (const field of Object.keys(shift)) {
      const without = Object.fromEntries(Object.entries(shift).filter(([key]) => key !== field));
      expect(officeShiftSchema.safeParse(without).success, `without ${field}`).toBe(false);
    }
  });

  it("refuse a shift to plan, to move or to close with a field of another form, and one that lacks what it needs", () => {
    const create = shiftCreateSchema.parse(fixture("shift-create.json"));
    const update = shiftUpdateSchema.parse(fixture("shift-update.json"));
    const close = shiftCloseSchema.parse(fixture("shift-close.json"));
    const refusedCreate: Record<string, unknown[]> = {
      productId: ["42", null],
      lineId: ["42", null],
      boxTemplateId: ["42", null],
      productionDate: [20261008, null],
      boxCapacity: [0, -1, 1.5, "12", null],
      plannedQty: [0, -1, 1.5, "1200"],
      counterpartyId: ["42"],
      mode: ["boxes", null],
      palletsEnabled: ["no", null],
      palletBoxCapacity: [0, -1, 1.5, "40", null],
      palletTemplateId: ["42", null],
    };
    for (const [field, values] of Object.entries(refusedCreate)) {
      for (const value of values) {
        const result = shiftCreateSchema.safeParse({ ...create, [field]: value });
        expect(result.success, `create ${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    for (const field of ["productId", "lineId", "productionDate", "boxTemplateId"]) {
      const without = Object.fromEntries(Object.entries(create).filter(([key]) => key !== field));
      expect(shiftCreateSchema.safeParse(without).success, `create without ${field}`).toBe(false);
    }
    // Only the four ids and the date are required; the rest may be left out or be null.
    const { productId, lineId, productionDate, boxTemplateId } = create;
    expect(
      shiftCreateSchema.safeParse({ productId, lineId, productionDate, boxTemplateId }).success,
    ).toBe(true);
    expect(
      shiftCreateSchema.safeParse({ ...create, plannedQty: null, counterpartyId: null }).success,
    ).toBe(true);
    const refusedUpdate: Record<string, unknown[]> = {
      lineId: ["42"],
      productionDate: [20261008],
      boxTemplateId: ["42"],
      boxCapacity: [0, -1, 1.5, "12"],
      plannedQty: [0, -1, 1.5, "1200"],
      counterpartyId: ["42"],
      mode: ["boxes"],
      palletsEnabled: ["no"],
      palletBoxCapacity: [0, -1, 1.5, "40", null],
      palletTemplateId: ["42", null],
      palletSheetTemplateId: ["42", 7],
      expectedRev: [1.5, "71", null],
    };
    for (const [field, values] of Object.entries(refusedUpdate)) {
      for (const value of values) {
        const result = shiftUpdateSchema.safeParse({ ...update, [field]: value });
        expect(result.success, `update ${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    expect(shiftUpdateSchema.safeParse({ lineId: update.lineId }).success).toBe(false);
    // `palletSheetTemplateId: null` is «the main sheet» (plan А4), not a refusal.
    expect(shiftUpdateSchema.safeParse({ ...update, palletSheetTemplateId: null }).success).toBe(
      true,
    );
    expect(
      shiftUpdateSchema.safeParse({ ...update, boxCapacity: 24, mode: "validation" }).success,
    ).toBe(true);
    for (const value of [1.5, "71", null]) {
      expect(shiftCloseSchema.safeParse({ ...close, expectedRev: value }).success).toBe(false);
    }
    for (const value of [5, null]) {
      expect(shiftCloseSchema.safeParse({ ...close, reason: value }).success).toBe(false);
    }
    expect(shiftCloseSchema.safeParse({ expectedRev: 71 }).success).toBe(false);
    expect(shiftCloseSchema.safeParse({ reason: close.reason }).success).toBe(false);
  });

  it("read a shift's figures, a planned shift's zeros among them, and refuse a figure of another form or a figure left out", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    // The live codes in the boxes against those in closed boxes: one box is still open.
    expect(shift.totals).toEqual({
      acceptedUnits: 547,
      unitsInClosedBoxes: 540,
      closedBoxes: 45,
      openBoxes: 1,
      lastFactAt: "2026-10-08T09:41:07Z",
      deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
      closedPallets: 0,
      openPallets: 0,
    });
    const planned = {
      ...shift,
      status: "planned",
      ownerDeviceId: null,
      openedAt: null,
      totals: {
        acceptedUnits: 0,
        unitsInClosedBoxes: 0,
        closedBoxes: 0,
        openBoxes: 0,
        lastFactAt: null,
        deviceIds: [],
        closedPallets: 0,
        openPallets: 0,
      },
    };
    expect(officeShiftSchema.parse(planned)).toEqual(planned);
    const refused: Record<string, unknown[]> = {
      acceptedUnits: [-1, 1.5, "547", null],
      unitsInClosedBoxes: [-1, 1.5, "540", null],
      closedBoxes: [-1, 1.5, "45", null],
      openBoxes: [-1, 1.5, "1", null],
      lastFactAt: ["yesterday", 20261008],
      deviceIds: [["42"], "7c9e6679-7425-40de-944b-e07fc1f90ae7", null],
      closedPallets: [-1, 1.5, "1", null],
      openPallets: [-1, 1.5, "1", null],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = officeShiftSchema.safeParse({
          ...shift,
          totals: { ...shift.totals, [field]: value },
        });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    for (const field of Object.keys(shift.totals)) {
      const totals = Object.fromEntries(
        Object.entries(shift.totals).filter(([key]) => key !== field),
      );
      expect(officeShiftSchema.safeParse({ ...shift, totals }).success, `without ${field}`).toBe(
        false,
      );
    }
    for (const totals of [null, [], undefined]) {
      expect(officeShiftSchema.safeParse({ ...shift, totals }).success, String(totals)).toBe(false);
    }
  });

  it("tolerate a figure a newer host adds to a shift's figures", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const newer = officeShiftSchema.safeParse({ ...shift, totals: { ...shift.totals, voided: 3 } });
    expect(newer.success).toBe(true);
    expect(newer.data?.totals.acceptedUnits).toBe(547);
  });

  it("read the refusals of a busy shift, of a prefix with no serials left and of layouts too large to open a shift", () => {
    expect(errorBodySchema.parse(fixture("error-shift-busy.json")).error).toMatchObject({
      code: "conflict",
      details: { constraint: "shift_busy" },
    });
    expect(errorBodySchema.parse(fixture("error-sscc-exhausted.json")).error).toMatchObject({
      code: "sscc_exhausted",
      details: { issuerPrefix: "460068200", extension: 0 },
    });
    expect(errorBodySchema.parse(fixture("error-snapshot-too-large.json")).error).toMatchObject({
      code: "conflict",
      details: { constraint: "snapshot_too_large" },
    });
  });
});

describe("a shift's export rows", () => {
  type Rows = ReturnType<typeof shiftExportRowsSchema.parse>;
  const rows = (): Rows => shiftExportRowsSchema.parse(fixture("shift-export-rows.json"));
  const refused = (value: unknown): boolean => !shiftExportRowsSchema.safeParse(value).success;

  it("read the nulls of a planned shift, an office close and an open box and pallet", () => {
    const base = rows();
    const planned: Rows = {
      ...base,
      shift: {
        ...base.shift,
        status: "planned",
        closedAt: null,
        stationClosedAt: null,
        lateDataAt: null,
      },
      organization: { name: "ООО «Атолл»", inn: null },
      codes: [],
      boxes: [],
      items: [],
      pallets: [],
    };
    expect(shiftExportRowsSchema.parse(planned)).toEqual(planned);
    const office: Rows = {
      ...base,
      shift: { ...base.shift, stationClosedAt: null, lateDataAt: "2026-10-08T15:00:00Z" },
      pallets: [{ ...base.pallets[0]!, sscc: null, closedAt: null, disassembledAt: null }],
    };
    expect(shiftExportRowsSchema.parse(office)).toEqual(office);
  });

  it("keep the group separator and the crypto tail of a code, and read an id, an SSCC or a code the domain will refuse as plain text", () => {
    const base = rows();
    expect(base.codes.every((code) => code.canonical.includes("\u001d"))).toBe(true);
    const odd: Rows = {
      ...base,
      codes: [{ ...base.codes[0]!, canonical: "not a km" }],
      boxes: [{ ...base.boxes[0]!, id: "box-1", sscc: "12345", palletId: "pallet-1" }],
      items: [{ boxId: "box-1", codeHash: "not-a-hash" }],
      pallets: [{ ...base.pallets[0]!, id: "pallet-1", sscc: "12345" }],
    };
    expect(shiftExportRowsSchema.parse(odd)).toEqual(odd);
  });

  const DROP = Symbol("drop the field");
  /** The fixture with the field at `path` set to `value`, or dropped. */
  function changed(path: string[], value: unknown): unknown {
    const copy: unknown = JSON.parse(JSON.stringify(rows()));
    let at = copy as Record<string, unknown>;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
    const last = path[path.length - 1]!;
    if (value === DROP) delete at[last];
    else at[last] = value;
    return copy;
  }

  it("refuse a missing field at any level", () => {
    const base = rows();
    const fields: [string[], string[]][] = [
      [[], Object.keys(base)],
      [["shift"], Object.keys(base.shift)],
      [["organization"], Object.keys(base.organization)],
      [["codes", "0"], Object.keys(base.codes[0]!)],
      [["boxes", "0"], Object.keys(base.boxes[0]!)],
      [["items", "0"], Object.keys(base.items[0]!)],
      [["pallets", "0"], Object.keys(base.pallets[0]!)],
    ];
    for (const [parent, keys] of fields) {
      for (const key of keys) {
        expect(refused(changed([...parent, key], DROP)), [...parent, key].join(".")).toBe(true);
      }
    }
  });

  it("refuse a shift that is no UUID, a status or date of another form and an instant that is no instant", () => {
    const cases: [string[], unknown][] = [
      [["shift", "id"], "42"],
      [["shift", "number"], ""],
      [["shift", "status"], "open"],
      [["shift", "productionDate"], "08.10.2026"],
      [["shift", "closedAt"], "yesterday"],
      [["shift", "stationClosedAt"], "yesterday"],
      [["shift", "lateDataAt"], "yesterday"],
      [["shift", "palletsEnabled"], "yes"],
      [["codes", "0", "scannedAt"], "yesterday"],
      [["codes", "0", "canonical"], null],
      [["boxes", "0", "openedAt"], null],
      [["boxes", "0", "closedAt"], "yesterday"],
      [["boxes", "0", "disassembledAt"], "yesterday"],
      [["pallets", "0", "openedAt"], null],
      [["pallets", "0", "closedAt"], "yesterday"],
      [["pallets", "0", "disassembledAt"], "yesterday"],
      [["organization", "inn"], 7701234567],
      [["items"], {}],
    ];
    for (const [path, value] of cases) {
      expect(refused(changed(path, value)), `${path.join(".")} = ${JSON.stringify(value)}`).toBe(
        true,
      );
    }
  });
});

describe("a station's shifts", () => {
  const listed = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
  const first = listed[0];
  const entered = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
  const plain = (name: string): Record<string, unknown> =>
    JSON.parse(JSON.stringify(fixture(name))) as Record<string, unknown>;

  /** Every key of `object` dropped in turn, to a parse that must fail. */
  function withoutEach(
    object: Record<string, unknown>,
    parse: (value: unknown) => { success: boolean },
    where: string,
  ): void {
    for (const field of Object.keys(object)) {
      const without = Object.fromEntries(Object.entries(object).filter(([key]) => key !== field));
      expect(parse(without).success, `${where} without ${field}`).toBe(false);
    }
  }

  it("take a list of the fixture's two shifts, one open and one planned", () => {
    expect(
      listed.map((shift) => [shift.number, shift.status, shift.ownerDeviceId === null]),
    ).toEqual([
      ["OCT26-004", "active", false],
      ["OCT26-005/S", "planned", true],
    ]);
    expect(deviceShiftsSchema.parse({ shifts: [] })).toEqual({ shifts: [] });
    expect(deviceShiftsSchema.safeParse({}).success).toBe(false);
    expect(deviceShiftsSchema.safeParse({ shifts: null }).success).toBe(false);
    expect(deviceShiftsSchema.safeParse(listed).success).toBe(false);
  });

  it("refuse a shift that lacks a field, and one whose field has the wrong form", () => {
    if (first === undefined) throw new Error("the fixture lists no shift");
    withoutEach(first, (value) => deviceShiftSchema.safeParse(value), "shift");
    const refused: Record<string, unknown[]> = {
      id: ["42", null],
      number: ["", null, 4],
      status: ["paused", null],
      mode: ["boxes", null],
      palletsEnabled: ["no", null],
      createdFrom: ["cloud", null],
      lineId: ["42", null],
      productId: ["42", null],
      productName: [null, 5],
      productGtin14: [null, 5],
      counterpartyName: [5],
      productionDate: ["08.10.2026", "2026-10-8", 20261008, null],
      plannedQty: [0, -1, 1.5, "1200"],
      boxCapacity: [0, -1, 1.5, "12", null],
      boxTemplateId: ["42", null],
      ownerDeviceId: ["42"],
      openedAt: ["yesterday", 5],
      closedAt: ["yesterday", 5],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = deviceShiftSchema.safeParse({ ...first, [field]: value });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it("take null where a planned shift has nothing yet, and a plan of one unit", () => {
    const planned = listed[1];
    if (planned === undefined) throw new Error("the fixture lists no second shift");
    for (const field of [
      "counterpartyName",
      "plannedQty",
      "ownerDeviceId",
      "openedAt",
      "closedAt",
    ]) {
      expect(planned).toHaveProperty(field, null);
      expect(deviceShiftSchema.safeParse({ ...planned, [field]: null }).success, field).toBe(true);
    }
    const later = {
      ...planned,
      status: "closed",
      mode: "validation",
      palletsEnabled: true,
      plannedQty: 1,
      closedAt: "2026-10-09T18:00:00Z",
    };
    expect(deviceShiftSchema.safeParse(later).success).toBe(true);
  });

  it("read the list leniently and drop what a newer host adds, in a shift and in the snapshot", () => {
    const list = plain("device-shifts.json") as { shifts: Record<string, unknown>[] };
    for (const shift of list.shifts) shift["addedLater"] = { deep: true };
    const parsed = deviceShiftsSchema.parse(list);
    expect(parsed).toEqual(deviceShiftsSchema.parse(fixture("device-shifts.json")));
    for (const shift of parsed.shifts) expect(shift).not.toHaveProperty("addedLater");

    const answer = plain("device-shift-entered.json") as {
      snapshot: {
        product: Record<string, unknown>;
        boxTemplate: Record<string, unknown>;
        addedLater?: boolean;
      };
    };
    answer.snapshot.addedLater = true;
    answer.snapshot.product["vatRate"] = 10;
    answer.snapshot.boxTemplate["author"] = "office";
    const read = enteredShiftSchema.parse(answer);
    expect(read).toEqual(entered);
    expect(read.snapshot).not.toHaveProperty("addedLater");
    expect(read.snapshot.product).not.toHaveProperty("vatRate");
    expect(read.snapshot.boxTemplate).not.toHaveProperty("author");
  });

  it("answer a shift's entry with its snapshot whole, and refuse one that lacks any part of it", () => {
    const answer = plain("device-shift-entered.json") as Record<string, unknown> & {
      snapshot: Record<string, unknown> & {
        product: Record<string, unknown>;
        boxTemplate: Record<string, unknown>;
      };
    };
    expect(entered.snapshot).toEqual(answer.snapshot);
    withoutEach(answer, (value) => enteredShiftSchema.safeParse(value), "entered shift");
    withoutEach(
      answer.snapshot,
      (value) => enteredShiftSchema.safeParse({ ...answer, snapshot: value }),
      "snapshot",
    );
    withoutEach(
      answer.snapshot.product,
      (value) =>
        enteredShiftSchema.safeParse({
          ...answer,
          snapshot: { ...answer.snapshot, product: value },
        }),
      "snapshot product",
    );
    withoutEach(
      answer.snapshot.boxTemplate,
      (value) =>
        enteredShiftSchema.safeParse({
          ...answer,
          snapshot: { ...answer.snapshot, boxTemplate: value },
        }),
      "snapshot template",
    );
    for (const snapshot of [null, "frozen", [], 5]) {
      expect(enteredShiftSchema.safeParse({ ...answer, snapshot }).success).toBe(false);
    }
  });

  it("refuse a snapshot field of the wrong form, and take null where a product has nothing", () => {
    const answer = plain("device-shift-entered.json") as Record<string, unknown> & {
      snapshot: Record<string, unknown> & {
        product: Record<string, unknown>;
        boxTemplate: Record<string, unknown>;
      };
    };
    const parse = (part: "snapshot" | "product" | "boxTemplate", field: string, value: unknown) => {
      const { snapshot } = answer;
      const changed =
        part === "snapshot"
          ? { ...snapshot, [field]: value }
          : { ...snapshot, [part]: { ...snapshot[part], [field]: value } };
      return enteredShiftSchema.safeParse({ ...answer, snapshot: changed }).success;
    };
    const refused: [Parameters<typeof parse>[0], string, unknown[]][] = [
      ["snapshot", "issuerPrefix", [null, 460068200]],
      ["snapshot", "counterpartyName", [5]],
      ["product", "id", ["42", null]],
      ["product", "gtin14", [null, 4600682000013]],
      ["product", "name", [null, 5]],
      ["product", "printName", [5]],
      ["product", "chzProductGroupCode", [-1, 1.5, "8", null]],
      ["product", "shelfLifeDays", [0, -1, 1.5, "10"]],
      ["boxTemplate", "id", ["42", null]],
      ["boxTemplate", "name", [null, 5]],
      ["boxTemplate", "rev", [1.5, "62", null]],
      ["boxTemplate", "spec", [null, "tspl", 5, [], [{ widthMm: 58 }]]],
    ];
    for (const [part, field, values] of refused) {
      for (const value of values) {
        expect(parse(part, field, value), `${part}.${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    for (const [part, field, value] of [
      ["snapshot", "counterpartyName", null],
      ["product", "printName", null],
      ["product", "shelfLifeDays", null],
      ["product", "chzProductGroupCode", 0],
      ["boxTemplate", "rev", 0],
      ["boxTemplate", "rev", -1],
    ] as const) {
      expect(parse(part, field, value), `${part}.${field}: ${String(value)}`).toBe(true);
    }
  });

  it("hold a layout as one opaque object, as large as the host keeps, without copying it", () => {
    // The host keeps at most 256 KiB of layout (`MAX_SPEC_BYTES`); the snapshot
    // schema neither measures nor rebuilds it: the domain's schema reads it
    // once, where the station enters the shift.
    const filler = "я".repeat(120_000);
    const spec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [],
      note: filler,
    };
    expect(JSON.stringify(spec).length).toBeGreaterThan(100_000);
    const answer = plain("device-shift-entered.json") as Record<string, unknown> & {
      snapshot: { boxTemplate: Record<string, unknown> };
    };
    answer.snapshot.boxTemplate["spec"] = spec;
    const read = enteredShiftSchema.parse(answer);
    expect(read.snapshot.boxTemplate.spec).toBe(spec);
    // Whatever keys a layout has stay (no strict or stripping parse of it).
    const odd = { anything: [1, { deep: null }], "": 1 };
    answer.snapshot.boxTemplate["spec"] = odd;
    expect(enteredShiftSchema.parse(answer).snapshot.boxTemplate.spec).toEqual(odd);
  });

  it("send a new shift with the four required fields and no other than the host's seven", () => {
    const create = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));
    for (const field of ["requestId", "productId", "boxTemplateId", "productionDate"]) {
      const without = Object.fromEntries(Object.entries(create).filter(([key]) => key !== field));
      expect(deviceShiftCreateSchema.safeParse(without).success, `without ${field}`).toBe(false);
    }
    const { requestId, productId, boxTemplateId, productionDate } = create;
    expect(
      deviceShiftCreateSchema.safeParse({ requestId, productId, boxTemplateId, productionDate })
        .success,
    ).toBe(true);
    expect(
      deviceShiftCreateSchema.safeParse({ ...create, plannedQty: 1200, counterpartyId: productId })
        .success,
    ).toBe(true);
    // The line is the station's own: a body that names one is another form.
    for (const extra of ["lineId", "mode", "palletsEnabled", "ownerDeviceId"]) {
      expect(
        deviceShiftCreateSchema.safeParse({ ...create, [extra]: productId }).success,
        extra,
      ).toBe(false);
    }
    const refused: Record<string, unknown[]> = {
      requestId: ["42", "", null, 5],
      productId: ["42", null],
      boxTemplateId: ["42", null],
      productionDate: [20261009, null],
      boxCapacity: [0, -1, 1.5, "12", null],
      plannedQty: [0, -1, 1.5, "1200"],
      counterpartyId: ["42", 5],
    };
    for (const [field, values] of Object.entries(refused)) {
      for (const value of values) {
        const result = deviceShiftCreateSchema.safeParse({ ...create, [field]: value });
        expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});

describe("facts of the floor", () => {
  const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;
  const NOT_UUID = ["42", "", null, 5, "8E1F2A3B-4C5D-4E6F-8A9B-0C1D2E3F4A5B ", true];

  /** The `index`-th record of facts-request.json, as the host's JSON. */
  function raw(index: number): { data: Record<string, unknown> } & Record<string, unknown> {
    return structuredClone(
      (fixture("facts-request.json") as { records: never[] }).records[index],
    ) as never;
  }

  /** `object` without `key`. */
  function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
  }

  it("know every receipt code of the host", () => {
    expect(fixture("fact-receipt-codes.json")).toEqual({ codes: [...FACT_RECEIPT_CODES] });
  });

  it("send 1 to 100 records in a batch", () => {
    const [first] = RECORDS;
    expect(factBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(factBatchSchema.safeParse({ records: Array(1).fill(first) }).success).toBe(true);
    expect(factBatchSchema.safeParse({ records: Array(100).fill(first) }).success).toBe(true);
    expect(factBatchSchema.safeParse({ records: Array(101).fill(first) }).success).toBe(false);
    expect(factBatchSchema.safeParse({}).success).toBe(false);
    // One record the build cannot read fails the batch it is put into.
    expect(
      factBatchSchema.safeParse({ records: [first, { ...first, kind: "pallet" }] }).success,
    ).toBe(false);
  });

  it("read a record's data by its kind, and no other", () => {
    const [scan, , closed] = RECORDS;
    expect(factRecordSchema.safeParse({ ...scan, kind: "box_closed" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...closed, kind: "scan" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...scan, kind: "pallet_closed" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...scan, operatorId: null }).success).toBe(true);
    expect(factRecordSchema.safeParse({ ...scan, operatorId: "0042" }).success).toBe(false);
  });

  it("read every record of the fixture, one of each kind, without losing a field", () => {
    expect(RECORDS.map((record) => record.kind)).toEqual([
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "box_exception",
      "shift_closed",
    ]);
    RECORDS.forEach((record, index) => {
      expect(factRecordSchema.parse(raw(index))).toEqual(raw(index));
      expect(record).toEqual(raw(index));
    });
  });

  it("refuse a field the record or its data does not have, like the host", () => {
    for (let index = 0; index < RECORDS.length; index++) {
      const record = raw(index);
      expect(factRecordSchema.safeParse({ ...record, addedLater: 1 }).success, `${index}`).toBe(
        false,
      );
      const data = { ...record.data, addedLater: 1 };
      expect(factRecordSchema.safeParse({ ...record, data }).success, `${index}.data`).toBe(false);
    }
    const scan = raw(0) as { data: { code: Record<string, unknown> } };
    const code = { ...scan.data.code, addedLater: 1 };
    expect(factRecordSchema.safeParse({ ...scan, data: { ...scan.data, code } }).success).toBe(
      false,
    );
  });

  it("need every field of the envelope and of the data, null where the host takes null", () => {
    for (let index = 0; index < RECORDS.length; index++) {
      const record = raw(index);
      for (const key of Object.keys(record)) {
        const rest = without(record, key);
        expect(factRecordSchema.safeParse(rest).success, `${index}: no ${key}`).toBe(false);
      }
      for (const key of Object.keys(record.data)) {
        const data = without(record.data, key);
        expect(factRecordSchema.safeParse({ ...record, data }).success, `${index}: no ${key}`).toBe(
          false,
        );
      }
    }
    const scan = raw(0) as { data: { code: Record<string, unknown> } };
    for (const key of Object.keys(scan.data.code)) {
      const code = without(scan.data.code, key);
      expect(
        factRecordSchema.safeParse({ ...scan, data: { ...scan.data, code } }).success,
        `code: no ${key}`,
      ).toBe(false);
    }
  });

  it("refuse a value of the wrong type or range in every field, as the host does", () => {
    // [record index, path in the record, values that must be refused]
    const refused: Array<[number, string, unknown[]]> = [
      [0, "id", NOT_UUID],
      [0, "shiftId", NOT_UUID],
      [0, "operatorId", ["42", "", 5, true]],
      [0, "data.scannedAt", [5, null, true]],
      [0, "data.verdict", ["maybe", "OK", "wrong-gtin", null, 1]],
      [0, "data.duplicateSource", ["remote", "LOCAL", 1, true]],
      [0, "data.rawKind", ["barcode", "KM", null, 1]],
      [0, "data.rawLength", [-1, 1.5, "83", null, true]],
      [0, "data.code", ["text", 5, []]],
      [0, "data.code.codeHash", [5, null, true]],
      [0, "data.code.gtin14", [5, null, true]],
      [0, "data.code.serial", [5, null, true]],
      [0, "data.code.canonical", [5, null, true]],
      [0, "data.boxId", NOT_UUID.filter((value) => value !== null)],
      [2, "data.boxId", NOT_UUID],
      [2, "data.sscc", [46006820000015000, null, true]],
      [2, "data.blockId", NOT_UUID],
      [2, "data.serial", [-1, 1.5, "1500", null, true]],
      [2, "data.openedAt", [5, null, true]],
      [2, "data.closedAt", [5, null, true]],
      [2, "data.itemCount", [0, -1, 1.5, "12", null, true]],
      [2, "data.membershipDigest", [5, null, true]],
      [3, "data.boxId", NOT_UUID],
      [3, "data.outcome", ["lost", "VERIFIED", "", null, true]],
      [3, "data.at", [5, null, true]],
      [4, "data.exception", ["redo", "UNDO", "", null, 1]],
      [4, "data.boxId", NOT_UUID],
      [4, "data.codeHash", [5, true]],
      [4, "data.targetScannedAt", [5, true]],
      [4, "data.reasonCode", [5, true]],
      [4, "data.reasonText", [5, true]],
      [4, "data.occurredAt", [5, null, true]],
      [5, "data.plannedQtySnapshot", [0, -1, 1.5, "1200", true]],
      [5, "data.actualQty", [-1, 1.5, "1188", null, true]],
      [5, "data.closedBoxCount", [-1, 1.5, "99", null, true]],
      [5, "data.reasonCode", [5, true]],
      [5, "data.closedAt", [5, null, true]],
    ];
    for (const [index, path, values] of refused) {
      for (const value of values) {
        const record = raw(index);
        const keys = path.split(".");
        const last = keys.pop() ?? "";
        const holder = keys.reduce(
          (node, key) => node[key] as Record<string, unknown>,
          record as Record<string, unknown>,
        );
        holder[last] = value;
        const result = factRecordSchema.safeParse(record);
        expect(result.success, `${index} ${path} = ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it("know the verdicts and the kinds of a scan the host knows, and no other", () => {
    // Mirrors `markiro_proto::ScanVerdict` and `ScanRawKind` (snake_case names).
    expect([...SCAN_VERDICTS]).toEqual(["ok", "duplicate", "wrong_gtin", "invalid"]);
    expect([...SCAN_RAW_KINDS]).toEqual(["km", "gtin", "sscc", "unknown"]);
  });

  it("take the edges of a field and the null where the host takes null", () => {
    const edge = (index: number, path: string, value: unknown) => {
      const record = raw(index);
      const keys = path.split(".");
      const last = keys.pop() ?? "";
      const holder = keys.reduce(
        (node, key) => node[key] as Record<string, unknown>,
        record as Record<string, unknown>,
      );
      holder[last] = value;
      return factRecordSchema.safeParse(record).success;
    };
    expect(edge(0, "data.rawLength", 0)).toBe(true);
    expect(edge(0, "data.verdict", "duplicate")).toBe(true);
    expect(edge(0, "data.verdict", "wrong_gtin")).toBe(true);
    expect(edge(0, "data.duplicateSource", "local")).toBe(true);
    expect(edge(0, "data.duplicateSource", "host")).toBe(true);
    expect(edge(0, "data.rawKind", "gtin")).toBe(true);
    expect(edge(0, "data.rawKind", "sscc")).toBe(true);
    expect(edge(0, "data.code", null)).toBe(true);
    expect(edge(0, "data.boxId", null)).toBe(true);
    expect(edge(2, "data.serial", 0)).toBe(true);
    expect(edge(2, "data.itemCount", 1)).toBe(true);
    expect(edge(3, "data.outcome", "skipped")).toBe(true);
    for (const exception of ["undo", "clear", "reprint", "disassemble"]) {
      expect(edge(4, "data.exception", exception), exception).toBe(true);
    }
    expect(edge(4, "data.reasonCode", null)).toBe(true);
    expect(edge(4, "data.reasonText", null)).toBe(true);
    expect(edge(4, "data.codeHash", "3f6c0f1e2d8b4a5c")).toBe(true);
    expect(edge(4, "data.targetScannedAt", "2026-10-08T06:15:02.418Z")).toBe(true);
    expect(edge(5, "data.plannedQtySnapshot", null)).toBe(true);
    expect(edge(5, "data.plannedQtySnapshot", 1)).toBe(true);
    expect(edge(5, "data.actualQty", 0)).toBe(true);
    expect(edge(5, "data.closedBoxCount", 0)).toBe(true);
    expect(edge(5, "data.reasonCode", null)).toBe(true);
  });

  it("read the pallets' records of protocol 3 and refuse what the host refuses (plan ПЛ-Ц)", () => {
    const [box, closed, label, exception] = factBatchSchema.parse(
      fixture("facts-request-pallets.json"),
    ).records;
    expect(box).toMatchObject({
      kind: "box_closed",
      data: { palletId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    });
    expect(closed).toMatchObject({ kind: "pallet_closed", data: { boxCount: 40, serial: 40 } });
    const data = (record: unknown, change: Record<string, unknown>) => ({
      ...(record as Record<string, unknown>),
      data: { ...(record as { data: Record<string, unknown> }).data, ...change },
    });
    expect(factRecordSchema.safeParse(data(box, { palletId: "pallet-1" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(closed, { boxCount: 0 })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(label, { outcome: "printed" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(exception, { exception: "undo" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(exception, { reasonCode: null })).success).toBe(false);
    // The records are exact: a field the host does not know is refused.
    for (const record of [closed, label, exception]) {
      expect(factRecordSchema.safeParse(data(record, { addedLater: true })).success).toBe(false);
    }
    // A pallet's record is read by its kind only: not as a box's.
    expect(factRecordSchema.safeParse({ ...(closed as object), kind: "box_closed" }).success).toBe(
      false,
    );
  });

  it("take a receipt code a newer host adds, and refuse a taken code without its owner", () => {
    const later = { receipts: [{ id: null, outcome: "rejected", code: "added_later" }] };
    expect(factReceiptsSchema.parse(later)).toEqual(later);
    expect(
      factReceiptsSchema.safeParse({ receipts: [{ id: null, outcome: "lost" }] }).success,
    ).toBe(false);
    expect(codeCheckSchema.safeParse({ status: "taken" }).success).toBe(false);
  });

  it("know the three outcomes of the host, and a receipt of each shape", () => {
    expect([...FACT_OUTCOMES]).toEqual(["accepted", "conflict", "rejected"]);
    for (const outcome of ["pending", "ACCEPTED", "", null, 1]) {
      expect(
        factReceiptsSchema.safeParse({ receipts: [{ id: null, outcome }] }).success,
        String(outcome),
      ).toBe(false);
    }
    const parse = (receipt: unknown) => factReceiptsSchema.safeParse({ receipts: [receipt] });
    for (const outcome of FACT_OUTCOMES) {
      expect(parse({ id: "x", outcome }).success, outcome).toBe(true);
      expect(parse({ id: null, outcome }).success, outcome).toBe(true);
    }
    // `id`, `outcome` are the receipt's own and must be there; `code` and `details` may not.
    expect(parse({ outcome: "accepted" }).success).toBe(false);
    expect(parse({ id: "x" }).success).toBe(false);
    for (const id of [5, true, {}, []]) {
      expect(parse({ id, outcome: "accepted" }).success, JSON.stringify(id)).toBe(false);
    }
    for (const code of [5, null, true]) {
      expect(parse({ id: "x", outcome: "rejected", code }).success, JSON.stringify(code)).toBe(
        false,
      );
    }
    for (const details of ["alreadyClosed", 5, null, [], [1]]) {
      expect(
        parse({ id: "x", outcome: "accepted", details }).success,
        JSON.stringify(details),
      ).toBe(false);
    }
    expect(parse({ id: "x", outcome: "accepted", details: {} }).success).toBe(true);
    // A later host may add fields to a receipt, and to the batch's answer.
    expect(parse({ id: "x", outcome: "accepted", addedLater: 1 }).success).toBe(true);
    expect(factReceiptsSchema.safeParse({ receipts: [], addedLater: 1 }).success).toBe(true);
    expect(factReceiptsSchema.safeParse({}).success).toBe(false);
  });

  it("keep a receipt's details whole, its winner included", () => {
    const [, conflict, , , , closed] = factReceiptsSchema.parse(
      fixture("facts-response.json"),
    ).receipts;
    expect(conflict?.details).toEqual({
      winner: {
        shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        shiftNumber: "OCT26-003",
        deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
        scannedAt: "2026-10-08T05:58:41.090Z",
        sameDevice: false,
      },
    });
    expect(closed?.details).toEqual({ alreadyClosed: true });
  });

  it("read the code check by its status, with the owner of a taken code in full", () => {
    expect(codeCheckSchema.parse({ status: "free" })).toEqual({ status: "free" });
    const taken = fixture("code-check-taken.json") as { owner: Record<string, unknown> };
    for (const status of ["maybe", "FREE", "", null, 1]) {
      expect(codeCheckSchema.safeParse({ ...taken, status }).success, String(status)).toBe(false);
    }
    expect(codeCheckSchema.safeParse({}).success).toBe(false);
    // A later host may add fields to the owner or to a free answer.
    expect(
      codeCheckSchema.safeParse({ ...taken, owner: { ...taken.owner, addedLater: 1 } }).success,
    ).toBe(true);
    expect(codeCheckSchema.safeParse({ status: "free", addedLater: 1 }).success).toBe(true);
    const owner = taken.owner;
    for (const [key, values] of Object.entries({
      shiftId: NOT_UUID,
      shiftNumber: [5, null, true],
      deviceId: NOT_UUID,
      scannedAt: [5, null, true],
      sameDevice: ["false", 0, null],
    })) {
      expect(
        codeCheckSchema.safeParse({ status: "taken", owner: { ...owner, [key]: undefined } })
          .success,
        `no ${key}`,
      ).toBe(false);
      for (const value of values) {
        expect(
          codeCheckSchema.safeParse({ status: "taken", owner: { ...owner, [key]: value } }).success,
          `${key} = ${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
  });

  it("read a block of serials, in full and in range", () => {
    const block = fixture("sscc-block.json") as Record<string, unknown>;
    const refused: Record<string, unknown[]> = {
      id: NOT_UUID,
      issuerPrefix: [460068200, null, true],
      extension: [-1, 10, 0.5, "0", null],
      fromSerial: [-1, 1.5, "1500", null],
      toSerial: [-1, 1.5, "3499", null],
    };
    for (const [key, values] of Object.entries(refused)) {
      expect(ssccBlockSchema.safeParse({ ...block, [key]: undefined }).success, `no ${key}`).toBe(
        false,
      );
      for (const value of values) {
        expect(
          ssccBlockSchema.safeParse({ ...block, [key]: value }).success,
          `${key} = ${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
    for (const extension of [0, 9]) {
      expect(ssccBlockSchema.safeParse({ ...block, extension }).success, `${extension}`).toBe(true);
    }
    expect(ssccBlockSchema.safeParse({ ...block, fromSerial: 0, toSerial: 0 }).success).toBe(true);
  });

  it("send a block request that names its id, prefix and an extension of 0 to 9", () => {
    const request = fixture("sscc-block-request.json") as Record<string, unknown>;
    const refused: Record<string, unknown[]> = {
      requestId: NOT_UUID,
      issuerPrefix: [460068200, null, true],
      extension: [-1, 10, 0.5, "0", null],
    };
    for (const [key, values] of Object.entries(refused)) {
      expect(ssccBlockRequestSchema.safeParse({ ...request, [key]: undefined }).success).toBe(
        false,
      );
      for (const value of values) {
        expect(
          ssccBlockRequestSchema.safeParse({ ...request, [key]: value }).success,
          `${key} = ${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
    for (const extension of [0, 9]) {
      expect(ssccBlockRequestSchema.safeParse({ ...request, extension }).success).toBe(true);
    }
  });
});

describe("a box's form data (plan О-Ф)", () => {
  type Report = ReturnType<typeof boxReportRowsSchema.parse>;
  const report = (): Report => boxReportRowsSchema.parse(fixture("box-report-rows.json"));
  const refused = (value: unknown): boolean => !boxReportRowsSchema.safeParse(value).success;

  it("reads the nulls of an open box, an unclosed one and a box with no codes", () => {
    const open: Report = {
      ...report(),
      sscc: null,
      closedAt: null,
      disassembledAt: null,
      organization: { name: "ООО «Атолл»", inn: null },
      items: [],
    };
    expect(boxReportRowsSchema.parse(open)).toEqual(open);
    const apart: Report = { ...report(), disassembledAt: "2026-10-08T07:00:00.000Z" };
    expect(boxReportRowsSchema.parse(apart)).toEqual(apart);
  });

  it("keeps the group separator and the crypto tail of a code, and reads a box id or an SSCC the domain will refuse as plain text", () => {
    const base = report();
    expect(base.items.every((item) => item.canonical.includes("\u001d"))).toBe(true);
    const odd: Report = {
      ...base,
      id: "box-1",
      sscc: "12345",
      items: [{ gtin14: "1", serial: "", canonical: "not a km" }],
    };
    expect(boxReportRowsSchema.parse(odd)).toEqual(odd);
  });

  it("refuses a missing field at every level", () => {
    const without = <T extends object>(value: T, field: string): object =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
    const base = report();
    for (const field of Object.keys(base)) {
      expect(refused(without(base, field)), field).toBe(true);
    }
    for (const field of Object.keys(base.organization)) {
      const organization = without(base.organization, field);
      expect(refused({ ...base, organization }), `organization.${field}`).toBe(true);
    }
    for (const field of Object.keys(base.items[0]!)) {
      const item = without(base.items[0]!, field);
      expect(refused({ ...base, items: [item] }), `items.${field}`).toBe(true);
    }
  });

  it("refuses a value of the wrong kind", () => {
    const base = report();
    const bad: [string, unknown][] = [
      ["shiftId", "not-a-uuid"],
      ["shiftId", null],
      ["id", null],
      ["sscc", 4600682],
      ["openedAt", "yesterday"],
      ["openedAt", null],
      ["closedAt", "2026-10-08"],
      ["disassembledAt", 5],
      ["productName", null],
      ["organization", null],
      ["items", null],
    ];
    for (const [field, value] of bad) {
      expect(refused({ ...base, [field]: value }), `${field}: ${JSON.stringify(value)}`).toBe(true);
    }
    expect(refused({ ...base, organization: { name: null, inn: null } })).toBe(true);
    expect(refused({ ...base, organization: { name: "ООО", inn: 7701234567 } })).toBe(true);
    for (const item of [
      { ...base.items[0]!, gtin14: null },
      { ...base.items[0]!, serial: 5 },
      { ...base.items[0]!, canonical: null },
    ]) {
      expect(refused({ ...base, items: [item] })).toBe(true);
    }
  });
});

describe("a shift's pallet form data (plan О-Ф)", () => {
  type Report = ReturnType<typeof palletReportRowsSchema.parse>;
  const report = (): Report => palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));
  const refused = (value: unknown): boolean => !palletReportRowsSchema.safeParse(value).success;
  const without = <T extends object>(value: T, field: string): object =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

  it("reads a shift without pallets, an open pallet, a pallet taken apart and a box taken apart", () => {
    const base = report();
    const pallet = base.pallets[0]!;
    const box = pallet.boxes[0]!;
    const bare: Report = {
      ...base,
      shift: { ...base.shift, shelfLifeDays: null },
      organization: { name: "ИП Иванов", inn: null },
      pallets: [],
    };
    expect(palletReportRowsSchema.parse(bare)).toEqual(bare);
    const open: Report = {
      ...base,
      pallets: [{ ...pallet, sscc: null, closedAt: null, disassembledAt: null, boxes: [] }],
    };
    expect(palletReportRowsSchema.parse(open)).toEqual(open);
    const apart: Report = {
      ...base,
      pallets: [
        {
          ...pallet,
          disassembledAt: "2026-10-08T07:00:00.000Z",
          boxes: [
            { ...box, disassembledAt: "2026-10-08T06:30:00.000Z", units: 0 },
            { ...box, sscc: null },
            box,
          ],
        },
      ],
    };
    expect(palletReportRowsSchema.parse(apart)).toEqual(apart);
  });

  it("reads an id or an SSCC the domain will refuse as plain text", () => {
    const base = report();
    const odd: Report = {
      ...base,
      pallets: [
        {
          ...base.pallets[0]!,
          id: "pallet-1",
          sscc: "12345",
          boxes: [{ ...base.pallets[0]!.boxes[0]!, id: "box-1", sscc: "67890" }],
        },
      ],
    };
    expect(palletReportRowsSchema.parse(odd)).toEqual(odd);
  });

  it("refuses a missing field at every level", () => {
    const base = report();
    for (const field of Object.keys(base)) {
      expect(refused(without(base, field)), field).toBe(true);
    }
    for (const field of Object.keys(base.shift)) {
      expect(refused({ ...base, shift: without(base.shift, field) }), `shift.${field}`).toBe(true);
    }
    for (const field of Object.keys(base.organization)) {
      const organization = without(base.organization, field);
      expect(refused({ ...base, organization }), `organization.${field}`).toBe(true);
    }
    const pallet = base.pallets[0]!;
    for (const field of Object.keys(pallet)) {
      expect(refused({ ...base, pallets: [without(pallet, field)] }), `pallets.${field}`).toBe(
        true,
      );
    }
    for (const field of Object.keys(pallet.boxes[0]!)) {
      const boxes = [without(pallet.boxes[0]!, field)];
      expect(refused({ ...base, pallets: [{ ...pallet, boxes }] }), `boxes.${field}`).toBe(true);
    }
  });

  it("refuses a value of the wrong kind", () => {
    const base = report();
    const pallet = base.pallets[0]!;
    const box = pallet.boxes[0]!;
    const badShift: [string, unknown][] = [
      ["id", "not-a-uuid"],
      ["id", null],
      ["number", ""],
      ["number", null],
      ["productionDate", "2026-10-8"],
      ["productionDate", null],
      ["productName", null],
      ["gtin14", 4600682000013],
      ["shelfLifeDays", 0],
      ["shelfLifeDays", 1.5],
      ["shelfLifeDays", "10"],
    ];
    for (const [field, value] of badShift) {
      const shift = { ...base.shift, [field]: value };
      expect(refused({ ...base, shift }), `shift.${field}: ${JSON.stringify(value)}`).toBe(true);
    }
    const badPallet: [string, unknown][] = [
      ["id", null],
      ["sscc", 1460068200],
      ["openedAt", "yesterday"],
      ["openedAt", null],
      ["closedAt", "2026-10-08"],
      ["disassembledAt", 5],
      ["boxes", null],
    ];
    for (const [field, value] of badPallet) {
      const row = { ...pallet, [field]: value };
      expect(refused({ ...base, pallets: [row] }), `pallets.${field}`).toBe(true);
    }
    const badBox: [string, unknown][] = [
      ["id", null],
      ["sscc", 4600682],
      ["closedAt", "yesterday"],
      ["closedAt", null],
      ["disassembledAt", "2026-10-08"],
      ["units", -1],
      ["units", 1.5],
      ["units", "2"],
      ["units", null],
    ];
    for (const [field, value] of badBox) {
      const boxes = [{ ...box, [field]: value }];
      expect(
        refused({ ...base, pallets: [{ ...pallet, boxes }] }),
        `boxes.${field}: ${JSON.stringify(value)}`,
      ).toBe(true);
    }
    expect(refused({ ...base, organization: { name: null, inn: null } })).toBe(true);
    expect(refused({ ...base, organization: { name: "ООО", inn: 7701234567 } })).toBe(true);
    expect(refused({ ...base, pallets: null })).toBe(true);
  });
});

describe("the A4 pallet sheets (plan А4)", () => {
  const sheet = fixture("pallet-sheet.json") as Record<string, unknown>;
  const list = fixture("pallet-sheets.json") as Record<string, unknown>;

  it("keeps the layout as the host sent it, whatever its shape", () => {
    // The host checks the version and the kind only; the domain reads the rest.
    for (const spec of [{ schemaVersion: 3, kind: "pallet_sheet", novel: [1, 2] }, "x", 7, null]) {
      expect(palletSheetSchema.parse({ ...sheet, spec }).spec).toEqual(spec);
    }
  });

  it("refuses a sheet the host would never send", () => {
    const refused = (change: Record<string, unknown>) =>
      palletSheetSchema.safeParse({ ...sheet, ...change }).success === false;
    expect(refused({ id: "not-a-uuid" })).toBe(true);
    expect(refused({ name: "" })).toBe(true);
    expect(refused({ enabled: "yes" })).toBe(true);
    expect(refused({ revision: 0 })).toBe(true);
    expect(refused({ revision: 1.5 })).toBe(true);
    expect(refused({ presetKey: undefined })).toBe(true);
    // A sheet of the office's own has no key, which the host writes as null.
    expect(palletSheetSchema.safeParse({ ...sheet, presetKey: null }).success).toBe(true);
  });

  it("reads the list with none as null, and refuses a list without the default", () => {
    expect(palletSheetsSchema.safeParse({ sheets: [], defaultId: null }).success).toBe(true);
    expect(palletSheetsSchema.safeParse({ sheets: [] }).success).toBe(false);
    expect(palletSheetsSchema.safeParse({ ...list, defaultId: "not-a-uuid" }).success).toBe(false);
    expect(
      palletSheetsSchema.safeParse({ ...list, sheets: [{ ...sheet, revision: 0 }] }).success,
    ).toBe(false);
  });

  it("builds requests the way the host takes them", () => {
    const create = { name: "Свой лист", spec: { schemaVersion: 2, kind: "pallet_sheet" } };
    expect(palletSheetCreateSchema.safeParse(create).success).toBe(true);
    expect(palletSheetCreateSchema.safeParse({ ...create, spec: [] }).success).toBe(false);
    expect(palletSheetCreateSchema.safeParse({ ...create, spec: "{}" }).success).toBe(false);
    expect(palletSheetCreateSchema.safeParse({ name: "x" }).success).toBe(false);
    // A rename carries no layout, and the revision is not optional.
    expect(palletSheetUpdateSchema.safeParse({ name: "x", expectedRevision: 1 }).success).toBe(
      true,
    );
    expect(palletSheetUpdateSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(
      palletSheetUpdateSchema.safeParse({ expectedRevision: 1, spec: create.spec }).success,
    ).toBe(false);
    // The default is a sheet or null, and the field is always there.
    expect(palletSheetDefaultUpdateSchema.safeParse({ templateId: null }).success).toBe(true);
    expect(palletSheetDefaultUpdateSchema.safeParse({}).success).toBe(false);
    expect(palletSheetDefaultUpdateSchema.safeParse({ templateId: "x" }).success).toBe(false);
  });
});

describe("protocol 5: the duplicate print (plan РЕЖ, part B)", () => {
  type Row = Record<string, unknown>;
  const TEMPLATE = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e";
  const printing = { mode: "duplicate_dm", verification: "none", templateId: TEMPLATE } as const;
  const create = fixture("shift-create-validation-print.json") as Row;
  const entered = fixture("device-shift-entered-validation-print.json") as Row & {
    snapshot: Row & { validationPrint: Row & { template: Row } };
  };
  const frozen = entered.snapshot.validationPrint;

  it("speaks protocol 5 with the domain's names", () => {
    expect(PROTOCOL_VERSION).toBe(5);
    expect(LABEL_VERIFICATIONS).toStrictEqual(["none", "required"]);
    expect(REPRINT_REASONS).toStrictEqual(["not_printed", "damaged", "lost"]);
    expect(UNIT_LABEL_EVENTS).toStrictEqual([
      "prepared",
      "sending",
      "sent",
      "failed_before_send",
      "delivery_unknown",
      "verified",
      "verification_rejected",
      "verification_skipped",
    ]);
    expectTypeOf<(typeof LABEL_VERIFICATIONS)[number]>().toEqualTypeOf<VerificationPolicy>();
    expectTypeOf<(typeof REPRINT_REASONS)[number]>().toEqualTypeOf<ReprintReason>();
    expectTypeOf<(typeof UNIT_LABEL_EVENTS)[number]>().toEqualTypeOf<ProductLabelEvent["kind"]>();
    expect(UNIT_LABEL_ERROR_CODES).toStrictEqual({
      failed_before_send: ["printer_unconfigured", "printer_changed"],
      delivery_unknown: ["transport_failed", "persistence_failed", "interrupted"],
      verification_rejected: ["invalid", "mismatch"],
    });
    type Of<K extends ProductLabelEvent["kind"]> = Extract<ProductLabelEvent, { kind: K }>;
    expectTypeOf<(typeof UNIT_LABEL_ERROR_CODES)["failed_before_send"][number]>().toEqualTypeOf<
      Of<"failed_before_send">["errorCode"]
    >();
    expectTypeOf<(typeof UNIT_LABEL_ERROR_CODES)["delivery_unknown"][number]>().toEqualTypeOf<
      Of<"delivery_unknown">["errorCode"]
    >();
    expectTypeOf<(typeof UNIT_LABEL_ERROR_CODES)["verification_rejected"][number]>().toEqualTypeOf<
      Of<"verification_rejected">["reason"]
    >();
  });

  it("reads exactly the policy's two shapes", () => {
    const read = (value: unknown) => validationPrintSchema.safeParse(value).success;
    expect(read({ mode: "none" })).toBe(true);
    expect(read(printing)).toBe(true);
    expect(read({ ...printing, verification: "required" })).toBe(true);
    expect(read({})).toBe(false);
    expect(read({ mode: "aggregation" })).toBe(false);
    expect(read({ mode: "duplicate_dm", verification: "none" })).toBe(false);
    expect(read({ mode: "duplicate_dm", templateId: TEMPLATE })).toBe(false);
    expect(read({ ...printing, verification: "optional" })).toBe(false);
    expect(read({ ...printing, templateId: "a-template" })).toBe(false);
    // The cloud's reprocessing of earlier codes is part C: not this wire.
    expect(read({ ...printing, allowPreviouslyAcceptedCodes: false })).toBe(false);
    expect(read({ mode: "none", templateId: TEMPLATE })).toBe(false);
  });

  it("plans a duplicate only for a validation shift", () => {
    const plan = (change: Row) => shiftCreateSchema.safeParse({ ...create, ...change }).success;
    expect(plan({})).toBe(true);
    expect(plan({ validationPrint: { mode: "none" } })).toBe(true);
    expect(plan({ mode: "aggregation", validationPrint: { mode: "none" } })).toBe(true);
    expect(plan({ mode: "aggregation" })).toBe(false);
    const withoutMode: Row = { ...create };
    delete withoutMode["mode"];
    // A plan without a mode is an aggregation shift's.
    expect(shiftCreateSchema.safeParse(withoutMode).success).toBe(false);
    expect(plan({ validationPrint: { mode: "duplicate_dm", verification: "none" } })).toBe(false);
  });

  it("refuses an edit to aggregation that keeps a duplicate", () => {
    const edit = (change: Row) =>
      shiftUpdateSchema.safeParse({ expectedRev: 4, ...change }).success;
    // Without a mode the edit keeps the shift's: the host checks it.
    expect(edit({ validationPrint: printing })).toBe(true);
    expect(edit({ mode: "validation", validationPrint: printing })).toBe(true);
    expect(edit({ mode: "aggregation", validationPrint: { mode: "none" } })).toBe(true);
    expect(edit({ mode: "aggregation", validationPrint: printing })).toBe(false);
  });

  it("reads a shift's policy only with its mode", () => {
    const office = fixture("office-shift-validation-print.json") as Row;
    expect(officeShiftSchema.safeParse({ ...office, mode: "aggregation" }).success).toBe(false);
    expect(
      officeShiftSchema.safeParse({
        ...office,
        mode: "aggregation",
        validationPrint: { mode: "none" },
      }).success,
    ).toBe(true);
    const listed: Row = { ...entered };
    delete listed["snapshot"];
    expect(deviceShiftSchema.parse(listed)).toStrictEqual(listed);
    expect(deviceShiftSchema.safeParse({ ...listed, mode: "aggregation" }).success).toBe(false);
  });

  it("enters a shift whose snapshot froze the shift's own policy", () => {
    const enter = (shift: Row) => enteredShiftSchema.safeParse(shift).success;
    const snapshot = (change: Row) => ({ ...entered.snapshot, ...change });
    expect(enter(entered)).toBe(true);
    expect(enter({ ...entered, validationPrint: { ...printing, verification: "required" } })).toBe(
      false,
    );
    expect(
      enter({
        ...entered,
        snapshot: snapshot({
          validationPrint: {
            ...frozen,
            template: { ...frozen.template, id: entered["boxTemplateId"] },
          },
        }),
      }),
    ).toBe(false);
    const noFrozen: Row = { ...entered.snapshot };
    delete noFrozen["validationPrint"];
    expect(enter({ ...entered, snapshot: noFrozen })).toBe(false);
    for (const policy of [undefined, { mode: "none" }]) {
      const shift: Row = { ...entered, validationPrint: policy };
      if (policy === undefined) delete shift["validationPrint"];
      expect(enter(shift)).toBe(false);
      expect(enter({ ...shift, snapshot: noFrozen })).toBe(true);
    }
  });

  it("enters a shift frozen before part B as it was", () => {
    for (const name of [
      "device-shift-entered.json",
      "device-shift-entered-pallets.json",
      "device-shift-entered-sheet.json",
      "device-shift-entered-validation.json",
    ]) {
      const shift = enteredShiftSchema.parse(fixture(name));
      expect(shift.validationPrint).toBeUndefined();
      expect(shift.snapshot.validationPrint).toBeUndefined();
      expect(JSON.stringify(shift.snapshot)).not.toContain("validationPrint");
    }
  });

  it("keeps a unit label event to the domain's rules, never with the full code", () => {
    const data = (name: string) => (fixture(`fact-unit-label-${name}.json`) as { data: Row }).data;
    const read = (value: Row) => unitLabelFactSchema.safeParse(value).success;
    const sent = data("sent");
    for (const name of ["prepared", "sent", "verified", "skipped", "unknown", "reprint"]) {
      expect(JSON.stringify(data(name))).not.toContain("\u001d");
      expect(read(data(name))).toBe(true);
    }
    // A reason only on the prepared event of a reprint.
    expect(read({ ...data("reprint"), reason: null })).toBe(false);
    expect(read({ ...data("prepared"), reason: "damaged" })).toBe(false);
    expect(read({ ...sent, attemptNo: 2, reason: "lost" })).toBe(false);
    expect(read({ ...sent, attemptNo: 2 })).toBe(true);
    expect(read({ ...data("reprint"), reason: "smudged" })).toBe(false);
    // An error code exactly where the domain has one, of that event's list.
    expect(read({ ...data("unknown"), errorCode: null })).toBe(false);
    expect(read({ ...data("unknown"), errorCode: "printer_changed" })).toBe(false);
    expect(read({ ...sent, event: "failed_before_send", errorCode: "printer_changed" })).toBe(true);
    expect(read({ ...sent, event: "verification_rejected", errorCode: "mismatch" })).toBe(true);
    expect(read({ ...sent, event: "verification_rejected", errorCode: null })).toBe(false);
    expect(read({ ...sent, errorCode: "interrupted" })).toBe(false);
    // Shapes: a job id, a code hash and digests, an attempt from 1.
    expect(read({ ...sent, event: "printed" })).toBe(false);
    expect(read({ ...sent, attemptNo: 0 })).toBe(false);
    expect(read({ ...sent, jobId: "job-1" })).toBe(false);
    expect(read({ ...sent, codeHash: "3F6C" })).toBe(false);
    expect(read({ ...sent, bytesDigest: "x".repeat(64) })).toBe(false);
    expect(read({ ...sent, code: "0104600682000013215Yq'Ct;\u001d93dGVz" })).toBe(false);
    // The printed text's digest has the shape of the others (B1 review).
    expect(read({ ...sent, payloadDigest: "8C1F" })).toBe(false);
    expect(read({ ...sent, payloadDigest: "8c1f".repeat(16).slice(1) })).toBe(false);
  });

  it("names the operator of a decision on a unit label record, as the host does", () => {
    const record = (name: string) => fixture(`fact-unit-label-${name}.json`) as Row;
    const read = (value: Row) => factRecordSchema.safeParse(value);
    // A skipped check and a reprint's `prepared` are the operator's decisions.
    for (const name of ["skipped", "reprint"]) {
      expect(read(record(name)).success, name).toBe(true);
      const answer = read({ ...record(name), operatorId: null });
      expect(answer.success, name).toBe(false);
      expect(answer.error?.issues.map((issue) => issue.path)).toStrictEqual([["operatorId"]]);
    }
    // Every other event may come without one (a restart's `delivery_unknown`).
    for (const name of ["prepared", "sent", "verified", "unknown"]) {
      expect(read({ ...record(name), operatorId: null }).success, name).toBe(true);
    }
  });

  it("keeps the unit label rules of the shared fixture, as the host does", () => {
    const rules = fixture("unit-label-rules.json") as {
      events: string[];
      errorCodes: Record<string, string[]>;
      reasons: string[];
      base: Row;
      cases: { change: Row; field: string | null }[];
    };
    expect(rules.events).toStrictEqual([...UNIT_LABEL_EVENTS]);
    expect(rules.reasons).toStrictEqual([...REPRINT_REASONS]);
    const codes: Readonly<Record<string, readonly string[]>> = UNIT_LABEL_ERROR_CODES;
    expect(Object.keys(rules.errorCodes)).toStrictEqual([...UNIT_LABEL_EVENTS]);
    for (const event of UNIT_LABEL_EVENTS) {
      expect(rules.errorCodes[event], event).toStrictEqual([...(codes[event] ?? [])]);
    }
    for (const { change, field } of rules.cases) {
      const answer = unitLabelFactSchema.safeParse({ ...rules.base, ...change });
      const paths = answer.success ? [] : answer.error.issues.map((issue) => issue.path);
      expect(paths, JSON.stringify(change)).toStrictEqual(field === null ? [] : [[field]]);
    }
  });

  it("enters no aggregation shift that prints (B1 review)", () => {
    const shift = { ...entered, mode: "aggregation" };
    const answer = enteredShiftSchema.safeParse(shift);
    expect(answer.success).toBe(false);
    expect(answer.error?.issues.map((issue) => issue.path)).toStrictEqual([["validationPrint"]]);
  });

  it("reads the label totals of a shift that prints, and none of another", () => {
    const office = officeShiftSchema.parse(fixture("office-shift-validation-print.json"));
    expect(office.totals.unitLabels).toStrictEqual({
      sent: 321,
      verified: 0,
      skipped: 0,
      unresolved: 2,
      reprints: 3,
    });
    expect(officeShiftSchema.parse(fixture("office-shift.json")).totals.unitLabels).toBeUndefined();
    const raw = fixture("office-shift-validation-print.json") as Row & { totals: Row };
    const totals = (unitLabels: unknown) => ({ ...raw, totals: { ...raw.totals, unitLabels } });
    expect(officeShiftSchema.safeParse(totals({ sent: -1 })).success).toBe(false);
    expect(
      officeShiftSchema.safeParse(
        totals({ sent: 1, verified: 0, skipped: 0, unresolved: 0.5, reprints: 0 }),
      ).success,
    ).toBe(false);
  });

  it("reads a policy with a field a newer host adds (B1 review)", () => {
    const office = fixture("office-shift-validation-print.json") as Row;
    const newer = {
      ...office,
      validationPrint: { ...printing, policyRevision: 3 },
    };
    expect(officeShiftSchema.safeParse(newer).success).toBe(true);
    const listed: Row = { ...entered, validationPrint: { mode: "none", note: "x" } };
    delete listed["snapshot"];
    expect(deviceShiftSchema.safeParse(listed).success).toBe(true);
    // A request takes exactly the policy's own fields.
    expect(validationPrintSchema.safeParse({ ...printing, policyRevision: 3 }).success).toBe(false);
  });
});
