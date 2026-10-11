import { readFileSync } from "node:fs";

import {
  labelFieldDisplayValue,
  labelTemplateSpecStrictSchema,
  type LabelField,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderLabel } from "../src/floor/print/label-render.js";
import { rasterizeText } from "../src/labels/rasterizer.js";
import { labelSampleData } from "../src/office/templates/label-samples.js";
import { MAX_STOCK_TEMPLATES, stockTemplates } from "../src/wizard/wizard-form.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** A drawing surface of the fake canvases: what was drawn, in which font. */
interface Drawn {
  font: string;
  text: string;
}

/** The jsdom canvas's `getContext` as `test/setup.ts` left it, saved before each test. */
let realGetContext: PropertyDescriptor = {};
let drawn: Drawn[] = [];

/**
 * A canvas with a width that follows the font as a real face's does: a glyph is
 * 0.6 em wide (IBM Plex Sans digits are about that), 0.62 for Cyrillic bold is
 * not needed to prove a layout renders. The bitmap read back is white.
 */
function installFakeCanvases(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement) {
      const surface = {
        font: "",
        width: this.width,
        height: this.height,
        fillStyle: "",
        textBaseline: "",
        measureText: (line: string) => {
          const fontPx = Number(/(\d+)px/.exec(surface.font)?.[1] ?? 0);
          return { width: line.length * fontPx * 0.6 };
        },
        fillRect: () => undefined,
        fillText: (text: string) => {
          drawn.push({ font: surface.font, text });
        },
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      };
      return surface;
    },
  });
}

beforeEach(() => {
  const saved = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (saved === undefined) throw new Error("test/setup.ts defines no canvas getContext");
  realGetContext = saved;
  drawn = [];
  installFakeCanvases();
});

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", realGetContext);
});

const LONG_NAME =
  "Напиток безалкогольный сильногазированный «Тархун» со вкусом лимона и мяты, ароматизированный, в стеклянной бутылке, ".repeat(
    2,
  );

function longData(purpose: "box" | "product_duplicate" | "pallet"): Record<LabelField, string> {
  return {
    ...labelSampleData(purpose),
    "product.name": LONG_NAME,
    "product.printName": LONG_NAME,
    "counterparty.name": LONG_NAME,
    qty: "9999",
    "qty.boxes": "999",
  };
}

const PRINTERS = [
  { language: "zpl", dpi: 203 },
  { language: "tspl", dpi: 203 },
  { language: "zpl", dpi: 300 },
  { language: "tspl", dpi: 300 },
] as const;

const without = (spec: LabelTemplateSpec): LabelTemplateSpec => ({
  ...spec,
  elements: spec.elements.filter((element) => element.kind !== "organization_logo"),
});

describe("the stock templates the wizard seeds", () => {
  // The request carries a layout as plain JSON; the domain reads it as the print does.
  const stock = stockTemplates().map((template) => ({
    ...template,
    spec: labelTemplateSpecStrictSchema.parse(template.spec),
  }));

  it("are the 21 the host's cap of 32 takes", () => {
    // 16 box, 2 product duplicate and 3 pallet templates; a change is a deliberate edit.
    expect(stock).toHaveLength(21);
    expect(stock.length).toBeLessThanOrEqual(MAX_STOCK_TEMPLATES);
    expect(MAX_STOCK_TEMPLATES).toBe(32);
    const host = readFileSync(new URL("../host/src/routes/bootstrap.rs", testModuleUrl), "utf8");
    expect(host).toMatch(/pub const MAX_STOCK_TEMPLATES: usize = 32;/);
  });

  it("include the standard layouts that carry the organization logo", () => {
    const withLogo = stock.filter((template) =>
      template.spec.elements.some((element) => element.kind === "organization_logo"),
    );
    expect(withLogo.length).toBeGreaterThanOrEqual(10);
  });

  it("each rasterize without throwing on a very long name, for either language and resolution", async () => {
    let rendered = 0;
    for (const template of stock) {
      const data = longData(
        template.purpose === "product_duplicate" ? "product_duplicate" : template.purpose,
      );
      for (const printer of PRINTERS) {
        const bytes = await renderLabel(template.spec, data, printer, rasterizeText);
        expect(bytes.length, `${template.name} ${printer.language}/${printer.dpi}`).toBeGreaterThan(
          0,
        );
        rendered += 1;
      }
    }
    expect(rendered).toBe(21 * 4);
  });

  it("print the same bytes with the logo element as without it: its area stays empty", async () => {
    let checked = 0;
    for (const template of stock) {
      if (!template.spec.elements.some((element) => element.kind === "organization_logo")) continue;
      const data = labelSampleData(template.purpose);
      for (const printer of PRINTERS) {
        const marked = await renderLabel(template.spec, data, printer, rasterizeText);
        const bare = await renderLabel(without(template.spec), data, printer, rasterizeText);
        expect(Buffer.from(marked).equals(Buffer.from(bare)), template.name).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it("shrink a quantity that is too wide at its size, down to its minimum, rather than cut it", async () => {
    const template = stock.find((candidate) => candidate.name === "Коробка 75×120");
    if (template === undefined) throw new Error("no 75×120 box template");
    const data = longData("box");
    await renderLabel(template.spec, data, { language: "zpl", dpi: 203 }, rasterizeText);
    const quantity = labelFieldDisplayValue("qty", data);
    const sizes = drawn.filter((d) => d.text === quantity).map((d) => d.font);
    // 17 pt is 48 px at 203 dpi: "9999 шт." is 230 dots wide there, the box 216.
    // The next size that fits, at 0.6 em a glyph, is 45 px.
    expect(sizes).toEqual(["700 45px IBM Plex Sans, sans-serif"]);
  });

  it("refuse, rather than cut, a quantity that does not fit even at the minimum", async () => {
    const template = stock.find((candidate) => candidate.name === "Коробка 75×120");
    if (template === undefined) throw new Error("no 75×120 box template");
    const data = { ...longData("box"), qty: "9".repeat(40) };
    await expect(
      renderLabel(template.spec, data, { language: "zpl", dpi: 203 }, rasterizeText),
    ).rejects.toThrow("Label quantity exceeds its box at minimum font size");
  });
});
