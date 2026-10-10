import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  canonicalSaltSchema,
  categoryTemplateDefaultSchema,
  changesResponseSchema,
  codeCheckSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
  counterpartyUpdateSchema,
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
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeProductSchema,
  officeSessionSchema,
  officeShiftSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorBadgeRecordSchema,
  operatorCreateSchema,
  operatorRecordSchema,
  operatorUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  pairingCodeRequestSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  productCreateSchema,
  productGroupSchema,
  productRecordSchema,
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
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
  shiftUpdate,
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
      maxProtocol: 2,
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
  ["sscc-state.json", ssccStateSchema],
  ["office-user-record.json", officeUserRecordSchema],
  ["error-unauthorized.json", errorBodySchema],
  ["pairing-code.json", pairingCodeSchema],
  ["changes-response.json", changesResponseSchema],
  ["counterparty-record.json", counterpartyRecordSchema],
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
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
  ["device-shifts.json", deviceShiftsSchema],
  ["device-shift-entered.json", enteredShiftSchema],
  ["sscc-block.json", ssccBlockSchema],
  ["code-check-free.json", codeCheckSchema],
  ["code-check-taken.json", codeCheckSchema],
  ["facts-response.json", factReceiptsSchema],
] as const;

const REQUESTS = [
  ["office-login-request.json", officeLoginRequestSchema],
  ["bootstrap-request.json", bootstrapRequestSchema],
  ["org-profile-update.json", orgProfileUpdateSchema],
  ["sscc-counter-update.json", ssccCounterUpdateSchema],
  ["block-sizes-update.json", blockSizesUpdateSchema],
  ["office-user-create.json", officeUserCreateSchema],
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
  ["counterparty-create.json", counterpartyCreateSchema],
  ["counterparty-update.json", counterpartyUpdateSchema],
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
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
  ["device-shift-create.json", deviceShiftCreateSchema],
  ["sscc-block-request.json", ssccBlockRequestSchema],
  ["facts-request.json", factBatchSchema],
] as const;

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

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
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(shiftCreate(typed)).toStrictEqual(fixture("shift-create.json"));
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
    expect(
      templateDefaultsUpdate(
        {
          defaultBoxTemplateId: box,
          defaultPalletTemplateId: pallet,
          defaultDuplicateTemplateId: duplicate,
          categories: rows,
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
        },
        9,
      ),
    ).toStrictEqual({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: [],
      expectedRev: 9,
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
      expectedRev: [1.5, "71", null],
    };
    for (const [field, values] of Object.entries(refusedUpdate)) {
      for (const value of values) {
        const result = shiftUpdateSchema.safeParse({ ...update, [field]: value });
        expect(result.success, `update ${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
    expect(shiftUpdateSchema.safeParse({ lineId: update.lineId }).success).toBe(false);
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

  it("read the refusals of a busy shift and of a prefix with no serials left", () => {
    expect(errorBodySchema.parse(fixture("error-shift-busy.json")).error).toMatchObject({
      code: "conflict",
      details: { constraint: "shift_busy" },
    });
    expect(errorBodySchema.parse(fixture("error-sscc-exhausted.json")).error).toMatchObject({
      code: "sscc_exhausted",
      details: { issuerPrefix: "460068200", extension: 0 },
    });
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
