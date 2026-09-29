import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
  counterpartyUpdateSchema,
  credentialSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  pairingCodeRequestSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";
import {
  badgeCreate,
  counterpartyCreate,
  counterpartyUpdate,
  deviceUpdate,
  lineCreate,
  lineUpdate,
  operatorCreate,
  operatorUpdate,
  pairingCodeRequest,
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
      protocol: 1,
      initialized: false,
    });
  });

  it("error bodies", () => {
    expect(errorBodySchema.parse(fixture("error-not-found.json")).error.code).toBe("not_found");
    expect(errorBodySchema.parse(fixture("error-with-details.json")).error.details).toEqual({
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 1,
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
    expect(
      operatorCreate({ login: "0042", name: "Анна Кузнецова", role: "Упаковщик", pinPhc }),
    ).toStrictEqual(fixture("operator-create.json"));
    const operator = officeOperatorSchema.parse(fixture("office-operator.json"));
    expect(
      operatorUpdate({ ...operator, role: "Упаковщик" }, { role: null, active: false, pinPhc }),
    ).toStrictEqual(fixture("operator-update.json"));
  });

  it("a badge to add", () => {
    const { badgePhc } = badgeCreateSchema.parse(fixture("badge-create.json"));
    expect(badgeCreate({ badgePhc, label: "Пропуск №7" })).toStrictEqual(
      fixture("badge-create.json"),
    );
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
    expect(operatorUpdate(anna, { pinPhc })).toStrictEqual({ pinPhc, expectedRev: 55 });
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

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});
