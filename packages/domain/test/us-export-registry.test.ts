import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FDA_SORTABLE_REGISTRY_V1,
  renderUsExportDictionary,
  traceExportRegistryHash,
} from "../src/traceability/export/registry-v1.js";
import { canonicalExportDigest } from "../src/traceability/export/canonical.js";

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
