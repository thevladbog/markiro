import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FDA_SORTABLE_REGISTRY_V1,
  renderUsExportDictionary,
  traceExportRegistryHash,
} from "../src/traceability/export/registry-v1.js";
import { canonicalExportDigest } from "../src/traceability/export/canonical.js";
import * as canonicalExports from "../src/traceability/export/canonical.js";

function exportedCanonicalJson(input: unknown): unknown {
  const serialize: unknown = Reflect.get(canonicalExports, "canonicalExportJson");
  expect(serialize, "canonicalExportJson must expose the validated canonical bytes").toBeTypeOf(
    "function",
  );
  if (typeof serialize !== "function") throw new Error("Missing canonicalExportJson");
  return serialize(input);
}

describe("canonical JSON extraction", () => {
  it("preserves alias ownership, null prototypes and legacy array property behavior", () => {
    const shared = { z: 1 };
    expect(exportedCanonicalJson({ b: shared, a: shared })).toBe('{"a":{"z":1},"b":{"z":1}}');
    expect(exportedCanonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 }))).toBe(
      '{"a":1,"b":2}',
    );
    let reads = 0;
    const array = Object.defineProperty([1], "0", {
      get() {
        reads++;
        return 2;
      },
    });
    Object.defineProperty(array, "hidden", { value: 3 });
    Object.defineProperty(array, Symbol("legacy"), { value: 4 });
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    expect(exportedCanonicalJson(array)).toBe("[2]");
    expect(reads).toBe(1);
  });
  it("preserves rejection classes, messages and object-accessor precedence", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const hiddenGetter = Object.defineProperty(getter, "hidden", { value: 1 });
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const cases: [unknown, string][] = [
      [undefined, "Export digest requires finite JSON values"],
      [NaN, "Export digest requires finite JSON values"],
      [Infinity, "Export digest requires finite JSON values"],
      [-Infinity, "Export digest requires finite JSON values"],
      [1n, "Export digest requires finite JSON values"],
      [Symbol("x"), "Export digest requires finite JSON values"],
      [() => 1, "Export digest requires finite JSON values"],
      [cycle, "Export digest cannot contain cycles"],
      [new Array(1), "Export digest requires dense JSON arrays"],
      [Object.assign([1], { extra: 2 }), "Export digest requires dense JSON arrays"],
      [new Date(0), "Export digest requires plain JSON objects"],
      [Object.create({ x: 1 }), "Export digest requires plain JSON objects"],
      [{ [Symbol("x")]: 1 }, "Export digest cannot discard hidden or symbol properties"],
      [hiddenGetter, "Export digest cannot discard hidden or symbol properties"],
      [
        Object.defineProperty({}, "a", {
          enumerable: true,
          get() {
            reads++;
            return 1;
          },
        }),
        "Export digest cannot evaluate getters",
      ],
      [
        Object.defineProperty({ a: undefined }, "z", {
          enumerable: true,
          get() {
            reads++;
            return 1;
          },
        }),
        "Export digest requires finite JSON values",
      ],
    ];
    for (const [value, message] of cases) {
      expect(() => exportedCanonicalJson(value)).toThrow(new TypeError(message));
      expect(() => canonicalExportDigest(value)).toThrow(new TypeError(message));
    }
    expect(reads).toBe(0);
  });
  it.each([
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [{ 2: "two", 10: "ten", 1: "one" }, '{"1":"one","10":"ten","2":"two"}'],
    [
      { events: [2, 1], findings: ["b", "a"], nested: { events: [2, 1] } },
      '{"events":[1,2],"findings":["a","b"],"nested":{"events":[2,1]}}',
    ],
    [
      { n: -0, text: "é😀\u0000\ud800", escape: '\n\t"\\' },
      '{"escape":"\\n\\t\\"\\\\","n":0,"text":"é😀\\u0000\\ud800"}',
    ],
    [null, "null"],
    [true, "true"],
    [[2, 1], "[2,1]"],
  ])("exposes literal bytes without changing digest: %j", (input, expected) => {
    expect(exportedCanonicalJson(input)).toBe(expected);
    expect(canonicalExportDigest(input)).toBe(
      createHash("sha256")
        .update(expected as string)
        .digest("hex"),
    );
  });
});

describe("FDA sortable registry v1", () => {
  it("keeps stable, unambiguous versioned columns for all three CTEs", () => {
    expect(FDA_SORTABLE_REGISTRY_V1.id).toBe("fda_sortable_xlsx");
    expect(FDA_SORTABLE_REGISTRY_V1.version).toBe(1);
    expect(FDA_SORTABLE_REGISTRY_V1.sheets.map((sheet) => sheet.key)).toEqual([
      "receiving",
      "transformation",
      "shipping",
    ]);
    for (const sheet of FDA_SORTABLE_REGISTRY_V1.sheets) {
      expect(new Set(sheet.fields.map((field) => field.key)).size).toBe(sheet.fields.length);
      expect(new Set(sheet.fields.map((field) => field.snapshotPath)).size).toBe(
        sheet.fields.length,
      );
      expect(new Set(sheet.fields.map((field) => field.header)).size).toBe(sheet.fields.length);
      for (const field of sheet.fields) {
        expect(field.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.header).toMatch(/^[\x20-\x7e]+$/);
        expect(field.sheet).toBe(sheet.key);
        expect(field.version).toBe(1);
        expect(field.sourceSection).toMatch(/21 CFR 1\.13(40|45|50)/);
        expect(field.sourceUrl).toMatch(/^https:\/\/www\.ecfr\.gov\//);
        expect(field.snapshotPath).not.toBe("");
      }
      expect(sheet.fields.map((field) => field.key)).toEqual(
        expect.arrayContaining([
          "tlc",
          "quantity",
          "unit_of_measure",
          "product_name",
          "product_brand_name",
          "product_commodity",
          "product_variety",
          "product_packaging_size_value",
          "product_packaging_size_uom",
          "product_packaging_style",
          "product_gtin",
          "tlc_source_reference_kind",
          "tlc_source_reference_value",
          "reference_document_ids",
          "reference_document_types",
          "reference_document_numbers",
          "event_id",
          "event_revision",
          "event_lifecycle",
          "line_role",
          "line_no",
          "lot_id",
          "product_id",
          "source_record",
        ]),
      );
    }
  });

  it("retains split descriptions, alternatives and conditional product KDEs", () => {
    for (const sheet of FDA_SORTABLE_REGISTRY_V1.sheets) {
      const fields = new Map(sheet.fields.map((field) => [field.key, field]));
      for (const key of ["brand_name", "commodity", "variety"])
        expect(fields.get(`product_${key}`)?.required).toBe("if_applicable");
      expect(fields.get("product_gtin")?.required).toBe("no");
      expect(fields.get("quantity")?.type).toBe("decimal");
      expect(fields.get("tlc")?.type).toBe("text");
      expect(fields.get("tlc_source_reference_value")?.required).toBe("if_applicable");
      const prefixes =
        sheet.key === "receiving"
          ? ["previous_source", "receiving_location", "tlc_source"]
          : sheet.key === "shipping"
            ? ["recipient", "ship_from", "tlc_source"]
            : ["transformation_location", "tlc_source"];
      for (const prefix of prefixes)
        for (const suffix of [
          "business_name",
          "phone_number",
          "address_kind",
          "street_address_or_coordinates",
          "city",
          "state_or_region",
          "zip_or_postal_code",
          "country_code",
          "country_display",
          "gln",
          "ffrn",
          "source_reference_url",
        ])
          expect(fields.has(`${prefix}_${suffix}`), `${sheet.key}:${prefix}_${suffix}`).toBe(true);
    }
  });

  it("records reviewed FDA cell groups without claiming identical template layout", () => {
    const [receiving, transformation, shipping] = FDA_SORTABLE_REGISTRY_V1.sheets;
    expect(receiving?.fields.find((field) => field.key === "date_received")).toMatchObject({
      header: "Date received",
      type: "date",
      snapshotPath: "event.eventDate",
      sourceSection: "21 CFR 1.1345; FDA Receiving!X1",
    });
    expect(shipping?.fields.find((field) => field.key === "date_shipped")?.sourceSection).toBe(
      "21 CFR 1.1340; FDA Shipping!X1",
    );
    expect(transformation?.fields.find((field) => field.key === "quantity")?.sourceSection).toBe(
      "21 CFR 1.1350; FDA Transformation!H1 (input), Z1 (output)",
    );
    expect(
      transformation?.fields.find((field) => field.key === "transformation_completed_date")
        ?.sourceSection,
    ).toBe("21 CFR 1.1350; FDA Transformation!S1");
  });

  it("cannot mutate nested fields or sheet order after a hash is obtained", () => {
    expect(Object.isFrozen(FDA_SORTABLE_REGISTRY_V1)).toBe(true);
    expect(Object.isFrozen(FDA_SORTABLE_REGISTRY_V1.sheets)).toBe(true);
    for (const sheet of FDA_SORTABLE_REGISTRY_V1.sheets) {
      expect(Object.isFrozen(sheet)).toBe(true);
      expect(Object.isFrozen(sheet.fields)).toBe(true);
      for (const field of sheet.fields) expect(Object.isFrozen(field)).toBe(true);
    }
  });

  it("pins the reviewed mapping hash for reproducible future artifacts", () => {
    expect(traceExportRegistryHash()).toBe(
      "b92f7b8a33380c686cd6ba389d1cff3345ae2682f7088621851780b02afc8216",
    );
  });

  it("generates the tracked dictionary from the same headers and requiredness", () => {
    const dictionary = renderUsExportDictionary();
    expect(dictionary).toBe(
      readFileSync(new URL("../../../docs/us/export-data-dictionary.md", import.meta.url), "utf8"),
    );
    const rows = dictionary
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    for (const sheet of FDA_SORTABLE_REGISTRY_V1.sheets)
      for (const field of sheet.fields)
        expect(rows).toContainEqual([
          field.key,
          field.header,
          field.required,
          field.type,
          field.snapshotPath,
          field.kdeGroup,
          field.sourceSection,
          field.sourceUrl,
          "1",
        ]);
  });
});

describe("canonical export digest", () => {
  it("matches independent SHA-256 of recursively sorted JSON object keys", () => {
    const canonical = '{"a":{"a":null,"z":"0012"},"events":[],"findings":[],"z":1}';
    expect(
      canonicalExportDigest({ z: 1, findings: [], a: { z: "0012", a: null }, events: [] }),
    ).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("ignores selected event and finding order without changing frozen arrays or exact values", () => {
    const eventA = {
      eventId: "a",
      snapshot: { documents: ["001", "002"], items: ["1.00", "2.00"] },
    };
    const eventB = { eventId: "b", snapshot: { documents: [] } };
    const first = { events: [eventA, eventB], findings: [{ code: "z" }, { code: "a" }] };
    const reversed = { findings: [{ code: "a" }, { code: "z" }], events: [eventB, eventA] };
    expect(canonicalExportDigest(first)).toBe(canonicalExportDigest(reversed));
    expect(first.events[0]?.snapshot.documents).toEqual(["001", "002"]);
    expect(canonicalExportDigest(first)).not.toBe(
      canonicalExportDigest({
        ...first,
        events: [
          { ...eventA, snapshot: { ...eventA.snapshot, documents: ["002", "001"] } },
          eventB,
        ],
      }),
    );
    expect(canonicalExportDigest({ quantity: "1.0" })).not.toBe(
      canonicalExportDigest({ quantity: "1.00" }),
    );
    expect(canonicalExportDigest({ value: "é" })).not.toBe(
      canonicalExportDigest({ value: "e\u0301" }),
    );
  });

  it.each([undefined, NaN, Infinity, 1n, new Date(0), { x: undefined }, [undefined]])(
    "rejects non-JSON input rather than silently losing source values: %s",
    (input) => {
      expect(() => canonicalExportDigest(input)).toThrow(TypeError);
    },
  );

  it("rejects cyclic and sparse arrays", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalExportDigest(cycle)).toThrow(TypeError);
    expect(() => canonicalExportDigest(new Array(2))).toThrow(TypeError);
  });
});
