import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import { makeSheetSpec, legacySpec } from "./support/pallet-sheet.js";

describe("stored label format boundary", () => {
  it("accepts a sheet without losing its conditional rows or logo binding", () => {
    const spec = makeSheetSpec();
    expect(domain.parseStoredLabelTemplate?.(spec)).toEqual(spec);
  });
  it("keeps legacy geometry and lenient unknown-key handling", () => {
    expect(domain.parseStoredLabelTemplate({ ...legacySpec, obsolete: true })).toEqual(legacySpec);
    expect(domain.parseLabelTemplate({ ...legacySpec, obsolete: true })).toEqual(legacySpec);
  });
  it.each([0, 1, 3, 99, "2"])(
    "rejects unknown version %s rather than interpreting it as V1",
    (schemaVersion) => {
      expect(() => domain.parseStoredLabelTemplate({ ...legacySpec, schemaVersion })).toThrow(
        "version",
      );
    },
  );
  it("refuses an unversioned sheet kind", () => {
    expect(() => domain.parseStoredLabelTemplate({ ...legacySpec, kind: "pallet_sheet" })).toThrow(
      domain.DomainError,
    );
  });
});

describe("strict pallet sheet geometry and elements", () => {
  it.each([
    ["language", { language: "zpl" }],
    [
      "image URL",
      {
        body: [
          {
            id: "logo",
            kind: "organization_logo",
            source: "organization",
            fallback: "markiro",
            maxHeightMm: 16,
            url: "https://example.com/logo.png",
          },
        ],
      },
    ],
    [
      "unknown field",
      { body: [{ id: "field", kind: "field", field: "operator.password", fontSizePt: 12 }] },
    ],
    [
      "nested barcode",
      { body: [{ id: "barcode", kind: "sscc", source: "sscc", moduleDots: 11, barHeightMm: 45 }] },
    ],
    [
      "executable condition",
      {
        body: [{ id: "t", kind: "text", text: "x", fontSizePt: 12, when: { expression: "true" } }],
      },
    ],
    [
      "external font",
      {
        body: [
          {
            id: "t",
            kind: "text",
            text: "x",
            fontSizePt: 12,
            fontFamily: "https://example.com/font",
          },
        ],
      },
    ],
    [
      "reserved lines exceed limit",
      {
        body: [
          {
            id: "t",
            kind: "field",
            field: "product.printName",
            fontSizePt: 12,
            maxLines: 2,
            reservedLines: 5,
          },
        ],
      },
    ],
  ])("rejects %s with a structured issue path", (_name, patch) => {
    try {
      domain.parseStoredLabelTemplate({ ...makeSheetSpec(), ...patch });
      expect.fail("accepted invalid sheet");
    } catch (error) {
      expect(error).toBeInstanceOf(domain.DomainError);
      expect((error as domain.DomainError).cause).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.any(String), message: expect.any(String) }),
        ]),
      );
    }
  });
  it("finds duplicate IDs across nested groups and the footer", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({
        ...spec,
        body: [
          {
            id: "group",
            kind: "stack",
            children: [{ id: "sscc", kind: "text", text: "x", fontSizePt: 12 }],
          },
        ],
      }),
    ).toThrow("id");
  });
  it.each([5, 12, 11.5])("refuses invalid GS1 module size %s", (moduleDots) => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({ ...spec, footer: { ...spec.footer, moduleDots } }),
    ).toThrow(domain.DomainError);
  });
  it("refuses bars below the GS1 minimum height", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({ ...spec, footer: { ...spec.footer, barHeightMm: 20 } }),
    ).toThrow(domain.DomainError);
  });
  it("refuses two copies on a portrait page", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({ ...spec, page: { ...spec.page, copies: 2 } }),
    ).toThrow("page");
  });
  it("requires a fitting SSCC preset inside a half sheet", () => {
    const spec = makeSheetSpec();
    const two = {
      ...spec,
      page: { ...spec.page, orientation: "landscape", copies: 2, cutLine: true },
    };
    expect(() => domain.parseStoredLabelTemplate(two)).toThrow("footer");
    expect(
      domain.parseStoredLabelTemplate({
        ...two,
        footer: { ...spec.footer, moduleDots: 9, fallbackModuleDots: 8 },
      }),
    ).toMatchObject({ page: { copies: 2 } });
  });
  it("refuses margins that leave no printable content", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({
        ...spec,
        page: { ...spec.page, marginsMm: { top: 10, bottom: 10, left: 110, right: 110 } },
      }),
    ).toThrow("margins");
  });
  it("requires positioned children within a canvas", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({
        ...spec,
        body: [
          {
            id: "c",
            kind: "canvas",
            heightMm: 30,
            children: [{ id: "t", kind: "text", text: "x", fontSizePt: 12 }],
          },
        ],
      }),
    ).toThrow(domain.DomainError);
  });
  it("rejects nonfinite coordinates", () => {
    const spec = makeSheetSpec();
    expect(() =>
      domain.parseStoredLabelTemplate({
        ...spec,
        body: [
          {
            id: "c",
            kind: "canvas",
            heightMm: 30,
            children: [
              {
                id: "t",
                kind: "text",
                text: "x",
                fontSizePt: 12,
                xMm: Infinity,
                yMm: 0,
                widthMm: 10,
              },
            ],
          },
        ],
      }),
    ).toThrow(domain.DomainError);
  });
  it("rejects over-deep and cyclic trees before recursive validation", () => {
    let node: unknown = { id: "leaf", kind: "text", text: "x", fontSizePt: 12 };
    for (let i = 0; i < 8; i++) node = { id: `group-${i}`, kind: "stack", children: [node] };
    expect(() => domain.parseStoredLabelTemplate({ ...makeSheetSpec(), body: [node] })).toThrow(
      "depth",
    );
    const cycle: { id: string; kind: string; children: unknown[] } = {
      id: "cycle",
      kind: "stack",
      children: [],
    };
    cycle.children.push(cycle);
    expect(() => domain.parseStoredLabelTemplate({ ...makeSheetSpec(), body: [cycle] })).toThrow(
      domain.DomainError,
    );
  });
  it("rejects 201 content nodes", () => {
    const body = Array.from({ length: 201 }, (_, i) => ({
      id: `t${i}`,
      kind: "text",
      text: "x",
      fontSizePt: 12,
    }));
    expect(() => domain.parseStoredLabelTemplate({ ...makeSheetSpec(), body })).toThrow("200");
  });
  it("rejects a positioned child extending outside its canvas", () => {
    const spec = makeSheetSpec();
    const body = [
      {
        id: "canvas",
        kind: "canvas",
        widthMm: 50,
        heightMm: 30,
        children: [
          {
            id: "text",
            kind: "text",
            text: "x",
            fontSizePt: 12,
            xMm: 40,
            yMm: 25,
            widthMm: 20,
            heightMm: 10,
          },
        ],
      },
    ];
    expect(() => domain.parseStoredLabelTemplate({ ...spec, body })).toThrow("canvas");
  });
  it("preserves every supported node and style in a structured editable sheet", () => {
    const spec = makeSheetSpec();
    const body = [
      {
        id: "stack",
        kind: "stack",
        gapMm: 2,
        paddingMm: { top: 1, right: 1, bottom: 1, left: 1 },
        children: [
          {
            id: "row",
            kind: "row",
            gapMm: 3,
            children: [
              {
                id: "text",
                kind: "text",
                text: "ПАЛЕТА",
                fontSizePt: 12,
                fontFamily: "IBM Plex Mono",
                bold: true,
                align: "center",
                overflow: "error",
                grow: 1,
              },
              { id: "field", kind: "field", field: "boxCount", fontSizePt: 24, widthMm: 20 },
            ],
          },
          { id: "line", kind: "line", thicknessMm: 0.3 },
          { id: "box", kind: "box", widthMm: 20, heightMm: 10, thicknessMm: 0.2, filled: false },
          { id: "spacer", kind: "spacer", heightMm: 2 },
          {
            id: "canvas",
            kind: "canvas",
            widthMm: 50,
            heightMm: 20,
            children: [
              {
                id: "positioned",
                kind: "field_row",
                label: "GTIN",
                field: "product.gtin",
                fontSizePt: 12,
                labelFontSizePt: 8,
                gapMm: 1,
                xMm: 0,
                yMm: 0,
                widthMm: 50,
                heightMm: 20,
              },
            ],
          },
        ],
      },
    ];
    expect(domain.parseStoredLabelTemplate({ ...spec, body })).toEqual({ ...spec, body });
  });
});
