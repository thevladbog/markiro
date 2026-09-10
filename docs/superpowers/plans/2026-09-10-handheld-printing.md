# Handheld (TSD) printing foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the handheld app its own printing path: configure a printer over Wi-Fi or Bluetooth, render a label to printer bytes on the device, send them, and report an outcome the operator can act on.

**Architecture:** The ZPL and TSPL emitters from `packages/domain` are ported to Kotlin under `core/label` and pinned to the TypeScript originals by fixtures exported from the domain package. Text outside printable ASCII is rasterized with `android.graphics` and emitted as an image field, exactly as the station does; barcodes and Latin text stay native printer commands. Two transports (`core/print`) sit behind one interface that asks the printer for its status before every send, so a refusal carries the printer's own reason. Printers live only on the device, in Room.

**Tech Stack:** Kotlin 2.2, Jetpack Compose / Material3, Hilt, Room, kotlinx.coroutines, `android.graphics` for rasterization, plain TCP sockets and Bluetooth SPP for transport, Robolectric + JUnit4 for tests. Fixture source: `packages/domain` (TypeScript, vitest).

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-09-10-handheld-printing-design.md` and brief `docs/design-briefs/10-tsd-handheld.md`. Screens are already drawn in `docs/design-briefs/markiro-tsd.pen`.
- **No server change in this slice.** No file under `apps/api` is modified.
- Printer configuration is device-local. `apps/station/src/lib/hardware-config.ts` states the rule: held on the device, not the server, so it configures and runs offline.
- Every user-visible string ships in both `app/src/main/res/values/strings.xml` (Russian) and `app/src/main/res/values-en/strings.xml` (English). A missing translation is a lint error. New keys use the `printer_` prefix.
- Russian is primary; English mirrors. Robolectric tests run under `ru-RU` unless a test sets the locale.
- `minSdk = 28`, `targetSdk = 35`, `compileSdk = 35`.
- An unknown send outcome never resends by itself. Only a person who has looked at the printer resolves it.
- Rasterized (non-ASCII) output is **not** byte-comparable to the station's. It is pinned on command framing, bitmap dimensions and placement only. Never assert glyph pixels.
- **Rounding:** every millimetre-to-dot conversion must round ties toward positive infinity, matching JavaScript's `Math.round`. In Kotlin use `roundToInt()`. **Never `kotlin.math.round`**, which rounds ties to even and silently shifts coordinates. Coordinates may be negative, so this is not academic.
- **The TSPL document contains raw binary** (the bitmap payload). Build documents as `ByteArray`, never as a `String` that is later encoded. Anything that UTF-8 encodes a byte above `0x7F` corrupts the bitmap.
- Gate before every commit that touches `apps/handheld`: `./gradlew testDebugUnitTest lintDebug assembleDebug` from `apps/handheld` must pass with zero lint errors. This is what CI runs.
- Commit after every task. Never squash tasks into one commit.

## File Structure

New Kotlin, under `apps/handheld/app/src/main/kotlin/app/markiro/handheld/`:

| File                                      | Responsibility                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `core/label/LabelSpec.kt`                 | The template data model: spec, the five element kinds, field enum, dpi. Pure data, no behaviour.                         |
| `core/label/LabelSpecCodec.kt`            | Parses a spec from JSON. Consumed by the fixture test now, by the shift bundle in the aggregation slice.                 |
| `core/label/LabelUnits.kt`                | `mmToDots`, `ptToDots`, `ptToMm`, `withPrinterDpi`, `labelFieldDisplayValue`, `needsImageRendering`.                     |
| `core/label/TextWrap.kt`                  | `wrapTextToWidth`, `clipWithEllipsis`, `estimatedTextWidthMm`, and the align offset shared by both emitters.             |
| `core/label/Monochrome.kt`                | RGBA to monochrome, bit packing, the ZPL-to-TSPL polarity flip, and the two image command builders.                      |
| `core/label/RasterizeText.kt`             | The `RasterizeText` interface plus `RasterResult` and its options. No Android types.                                     |
| `core/label/ZplEmitter.kt`                | Spec plus data to a ZPL document.                                                                                        |
| `core/label/TsplEmitter.kt`               | Spec plus data to a TSPL document.                                                                                       |
| `core/label/AndroidTextRasterizer.kt`     | The one Android-dependent file: draws a text run with `Paint`/`Canvas` and hands pixels to `Monochrome`.                 |
| `core/label/LabelRenderer.kt`             | The single entry point the rest of the app calls. Picks the emitter from the printer's language, applies its resolution. |
| `core/label/TestLabel.kt`                 | The compiled-in test-label spec and its sample data.                                                                     |
| `core/print/PrinterEntities.kt`           | Room entity and DAO for saved printers.                                                                                  |
| `core/print/PrinterTransport.kt`          | The transport interface, `PrinterStatus`, `SendOutcome`.                                                                 |
| `core/print/WifiPrinterTransport.kt`      | TCP socket transport.                                                                                                    |
| `core/print/BluetoothPrinterTransport.kt` | Bluetooth SPP transport and paired-device discovery.                                                                     |
| `core/print/PrintModule.kt`               | Hilt bindings for the transports and the renderer.                                                                       |
| `feature/printer/PrinterViewModel.kt`     | State for the printer list, the add form, discovery and the test print.                                                  |
| `feature/printer/PrinterScreens.kt`       | The five drawn screens.                                                                                                  |

Modified: `core/storage/HandheldDatabase.kt`, `core/storage/Migrations.kt`, `core/storage/StorageModule.kt`, `core/storage/DeviceWipe.kt`, `feature/settings/SettingsScreens.kt`, `feature/hub/HubViewModel.kt`, `AppNavigation.kt`, `app/src/main/AndroidManifest.xml`, both `strings.xml`, `apps/handheld/README.md`, `docs/architecture.md`.

New TypeScript, under `packages/domain/`: `src/labels/label-fixtures.ts`, `scripts/export-label-fixtures.mjs`, `test/label-fixtures.test.ts`, plus one script entry in `package.json`.

## Scope note on barcode formats

The spec implements `code128` only. `datamatrix`, `qr` and `ean13` are refused by name. The stock box templates use `code128` alone, and matrix codes carry an unresolved hardware question in the TypeScript source that this slice does not inherit. `ean13` would be one line in each emitter if it is ever wanted; it is left out to keep the refusal rule uniform and the fixture set honest.

Note for the implementer: no barcode is ever encoded on the device. `packages/domain/src/labels/code128.ts` is a width model, not an encoder, and its own header says real encoding happens on the printer. Both emitters pass the payload to a native printer command.

---

### Task 1: Shared label fixtures in the domain package

**Files:**

- Create: `packages/domain/src/labels/label-fixtures.ts`
- Create: `packages/domain/scripts/export-label-fixtures.mjs`
- Create: `packages/domain/test/label-fixtures.test.ts`
- Modify: `packages/domain/package.json` (one script entry)
- Generated and committed: `apps/handheld/app/src/test/resources/label-fixtures.json`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: the JSON every later port task asserts against. Top-level shape `{ byteIdentical: ByteIdenticalFixture[], structural: StructuralFixture[] }`, described below.

Why two groups: a spec whose every text run is printable ASCII emits no image command, so both documents are printable text and can be compared byte for byte. A spec with Cyrillic emits an image whose glyph pixels come from the platform's font engine, and Android's differs from the browser canvas the station and cabinet preview share. Those cases record the command framing with the payload reduced to its dimensions.

- [ ] **Step 1: Write the fixture builder**

Create `packages/domain/src/labels/label-fixtures.ts`:

```ts
/**
 * Label rendering cases the handheld's Kotlin `ZplEmitter` and `TsplEmitter`
 * must reproduce. Exported to
 * `apps/handheld/app/src/test/resources/label-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:labels`;
 * `test/label-fixtures.test.ts` fails when the committed JSON drifts.
 *
 * Two groups. `byteIdentical` holds specs whose every text run is printable
 * ASCII: no image command is emitted, both documents are printable text, and
 * the Kotlin port must produce them character for character. `structural`
 * holds specs with Cyrillic: the emitted image payload comes from the
 * platform's font engine, which on Android is a third implementation next to
 * the browser canvas the station and the cabinet preview share, so only the
 * command framing and the bitmap's dimensions and placement are pinned.
 */
import { generateTspl } from "./tspl.js";
import { generateZpl } from "./zpl.js";
import type { LabelField, LabelTemplateSpec } from "./model.js";
import type { RasterResult, RasterizeTextOptions } from "./raster-types.js";

export interface ByteIdenticalFixture {
  name: string;
  spec: LabelTemplateSpec;
  data: Record<LabelField, string>;
  zpl: string;
  tspl: string;
}

export interface RasterCall {
  text: string;
  fontSizePx: number;
  bold: boolean;
  maxWidthPx: number | null;
  maxLines: number;
}

export interface StructuralFixture {
  name: string;
  spec: LabelTemplateSpec;
  data: Record<LabelField, string>;
  /** Every rasterizeText call the emitters make, in order, from the ZPL pass. */
  rasterCalls: RasterCall[];
  /** The ZPL document with each `^GFA` payload replaced by `<hex:N>` where N is its length. */
  zplShape: string;
  /** The TSPL document's command names and non-payload parameters, one line per command. */
  tsplShape: string[];
}

export interface LabelFixtures {
  byteIdentical: ByteIdenticalFixture[];
  structural: StructuralFixture[];
}

const DATA: Record<LabelField, string> = {
  "product.name": "Вода питьевая 0,5 л",
  "product.printName": "Вода 0,5",
  "product.gtin": "04600682000013",
  "product.egais": "0101234567890123456",
  "km.code": "010460068200001321abcDEF1234567",
  sscc: "346006820000000014",
  "shift.no": "214",
  date: "23.07.2026",
  expiry: "19.01.2027",
  qty: "20",
  operator: "Smirnov A.",
  "counterparty.name": "Zavod Partner",
};

function spec(elements: LabelTemplateSpec["elements"], dpi: 203 | 300 = 203): LabelTemplateSpec {
  return { widthMm: 58, heightMm: 40, dpi, language: "zpl", elements };
}

/**
 * A deterministic stand-in for a font engine: every glyph is a fixed box, so a
 * fixture records what the emitters DO with a bitmap, never what a rasterizer
 * draws. Honours the maxWidthPx contract by clamping.
 */
function stubRasterizer(calls: RasterCall[]) {
  return async (text: string, opts: RasterizeTextOptions): Promise<RasterResult> => {
    calls.push({
      text,
      fontSizePx: opts.fontSizePx,
      bold: opts.bold,
      maxWidthPx: opts.maxWidthPx ?? null,
      maxLines: opts.maxLines ?? 1,
    });
    const natural = Math.max(1, [...text].length) * Math.ceil(opts.fontSizePx * 0.5);
    const width = opts.maxWidthPx === undefined ? natural : Math.min(natural, opts.maxWidthPx);
    const height = Math.ceil(opts.fontSizePx * 1.5);
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    return {
      hex: "A5".repeat(totalBytes),
      totalBytes,
      bytesPerRow,
      width,
      height,
    };
  };
}

function asciiCases(): { name: string; spec: LabelTemplateSpec }[] {
  return [
    {
      name: "plain text and a field",
      spec: spec([
        { kind: "text", id: "t1", xMm: 2, yMm: 2, text: "ACME Foods", fontSizePt: 12 },
        { kind: "field", id: "f1", xMm: 2, yMm: 10, field: "product.gtin", fontSizePt: 10 },
      ]),
    },
    {
      name: "wrapped and aligned text",
      spec: spec([
        {
          kind: "text",
          id: "t1",
          xMm: 2,
          yMm: 2,
          text: "Cold storage keep upright",
          fontSizePt: 9,
          maxWidthMm: 30,
          maxLines: 3,
          align: "center",
        },
        {
          kind: "text",
          id: "t2",
          xMm: 2,
          yMm: 20,
          text: "Right",
          fontSizePt: 9,
          maxWidthMm: 30,
          align: "right",
        },
      ]),
    },
    {
      name: "sscc barcode with a module width",
      spec: spec([
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: "sscc",
          sizeMm: 15,
          moduleWidthMm: 0.25,
        },
        { kind: "field", id: "f1", xMm: 4, yMm: 30, field: "sscc", fontSizePt: 8 },
      ]),
    },
    {
      name: "literal barcode without a module width",
      spec: spec([
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: { literal: "ABC-123" },
          sizeMm: 10,
        },
      ]),
    },
    {
      name: "lines and boxes including a reversed line",
      spec: spec([
        { kind: "line", id: "l1", xMm: 0, yMm: 20, x2Mm: 58, y2Mm: 20, thicknessMm: 0.25 },
        { kind: "line", id: "l2", xMm: 40, yMm: 30, x2Mm: 10, y2Mm: 30, thicknessMm: 0.5 },
        { kind: "box", id: "x1", xMm: 0, yMm: 0, widthMm: 58, heightMm: 40, thicknessMm: 0.25 },
      ]),
    },
    {
      name: "negative and half millimetre coordinates at 300 dpi",
      spec: spec(
        [
          { kind: "text", id: "t1", xMm: -1.5, yMm: 2.5, text: "Edge", fontSizePt: 8 },
          {
            kind: "box",
            id: "x1",
            xMm: 0.5,
            yMm: 0.5,
            widthMm: 10.5,
            heightMm: 5.5,
            thicknessMm: 0.5,
          },
        ],
        300,
      ),
    },
    {
      name: "text needing zpl hex escapes",
      spec: spec([{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "A^B~C_D", fontSizePt: 10 }]),
    },
    {
      name: "text needing tspl quote escapes",
      spec: spec([{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: 'Say "hi"', fontSizePt: 10 }]),
    },
    {
      name: "empty element list",
      spec: spec([]),
    },
  ];
}

function cyrillicCases(): { name: string; spec: LabelTemplateSpec }[] {
  return [
    {
      name: "cyrillic product name unbounded",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 2, field: "product.name", fontSizePt: 12 },
      ]),
    },
    {
      name: "cyrillic product name centred in a box",
      spec: spec([
        {
          kind: "field",
          id: "f1",
          xMm: 2,
          yMm: 2,
          field: "product.name",
          fontSizePt: 10,
          maxWidthMm: 40,
          maxLines: 2,
          align: "center",
        },
      ]),
    },
    {
      name: "qty always rasterizes because of its unit suffix",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 20, field: "qty", fontSizePt: 9, bold: true },
      ]),
    },
    {
      name: "cyrillic beside an ascii barcode",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 2, field: "product.name", fontSizePt: 10 },
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: "sscc",
          sizeMm: 15,
          moduleWidthMm: 0.25,
        },
      ]),
    },
  ];
}

const GFA = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]*)/g;

function reduceZpl(document: string): string {
  return document.replace(
    GFA,
    (_m, a, b, c, hex: string) => `^GFA,${a},${b},${c},<hex:${hex.length}>`,
  );
}

/**
 * TSPL carries the bitmap as raw bytes, so the document is split on newlines
 * and a BITMAP line keeps only its parameters. Splitting is safe here because
 * the payload is replaced wholesale: a 0x0A inside it would end the recorded
 * line early, which is why only the parameter prefix is kept.
 */
function reduceTspl(document: string): string[] {
  const out: string[] = [];
  for (const line of document.split("\n")) {
    if (line.startsWith("BITMAP ")) {
      const params = line.slice("BITMAP ".length).split(",");
      out.push(`BITMAP ${params.slice(0, 5).join(",")},<payload>`);
    } else if (line !== "") {
      out.push(line);
    }
  }
  return out;
}

export async function buildLabelFixtures(): Promise<LabelFixtures> {
  const byteIdentical: ByteIdenticalFixture[] = [];
  for (const { name, spec: s } of asciiCases()) {
    byteIdentical.push({
      name,
      spec: s,
      data: DATA,
      zpl: await generateZpl(s, DATA),
      tspl: await generateTspl(s, DATA),
    });
  }
  const structural: StructuralFixture[] = [];
  for (const { name, spec: s } of cyrillicCases()) {
    const calls: RasterCall[] = [];
    const zpl = await generateZpl(s, DATA, { rasterizeText: stubRasterizer(calls) });
    const tspl = await generateTspl(s, DATA, { rasterizeText: stubRasterizer([]) });
    structural.push({
      name,
      spec: s,
      data: DATA,
      rasterCalls: calls,
      zplShape: reduceZpl(zpl),
      tsplShape: reduceTspl(tspl),
    });
  }
  return { byteIdentical, structural };
}
```

- [ ] **Step 2: Write the export script**

Create `packages/domain/scripts/export-label-fixtures.mjs`:

```js
// Writes the label rendering fixtures the handheld's Kotlin tests consume.
// Runs against the built package (`pnpm --filter @markiro/domain fixtures:labels`
// builds first) because the sources use `.js` import specifiers that Node's
// type stripping does not rewrite.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLabelFixtures } from "../dist/labels/label-fixtures.js";

const target = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/label-fixtures.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(await buildLabelFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
```

- [ ] **Step 3: Add the script entry**

In `packages/domain/package.json`, add after the `fixtures:inventory` line (mind the comma on the preceding line):

```json
    "fixtures:labels": "pnpm run build && node scripts/export-label-fixtures.mjs"
```

- [ ] **Step 4: Write the drift test**

Create `packages/domain/test/label-fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLabelFixtures } from "../src/labels/label-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/label-fixtures.json", import.meta.url),
);

describe("label fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", async () => {
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed).toBe(JSON.stringify(await buildLabelFixtures(), null, 2) + "\n");
  });

  it("cover every element kind and both resolutions without leaking an image into the byte-identical group", async () => {
    const fixtures = await buildLabelFixtures();
    const kinds = new Set(
      fixtures.byteIdentical.flatMap((f) => f.spec.elements.map((e) => e.kind)),
    );
    for (const kind of ["text", "field", "barcode", "line", "box"]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(new Set(fixtures.byteIdentical.map((f) => f.spec.dpi))).toEqual(new Set([203, 300]));
    for (const fixture of fixtures.byteIdentical) {
      expect(fixture.zpl, fixture.name).not.toContain("^GFA");
      expect(fixture.tspl, fixture.name).not.toContain("BITMAP");
    }
    expect(fixtures.structural.length).toBeGreaterThanOrEqual(4);
    for (const fixture of fixtures.structural) {
      expect(fixture.rasterCalls.length, fixture.name).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 5: Generate the fixtures and run the domain tests**

From the repository root:

```bash
pnpm --filter @markiro/domain --config.verify-deps-before-run=false fixtures:labels
```

Expected: `wrote /…/apps/handheld/app/src/test/resources/label-fixtures.json`.

```bash
pnpm --filter @markiro/domain --config.verify-deps-before-run=false test
```

Expected: all suites pass, including the two new label-fixture tests.

- [ ] **Step 6: Check formatting**

```bash
pnpm exec prettier --check packages/domain/src/labels/label-fixtures.ts packages/domain/scripts/export-label-fixtures.mjs packages/domain/test/label-fixtures.test.ts packages/domain/package.json
```

Expected: `All matched files use Prettier code style!`. If not, rerun with `--write`.

The generated JSON is written by `JSON.stringify` and is deliberately not Prettier-formatted; do not run Prettier over it.

- [ ] **Step 7: Commit**

```bash
git add packages/domain apps/handheld/app/src/test/resources/label-fixtures.json
git commit -m "test(domain): export label rendering fixtures for the handheld port"
```

---

### Task 2: Label model, units and field formatting in Kotlin

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpec.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelUnits.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpecCodec.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelUnitsTest.kt`

**Interfaces:**

- Consumes: `KmCodec.canonicalize` from `core/km/KmCodec.kt` and `ScanClassifier.parseSscc` from `core/inventory/ScanClassifier.kt`.
- Produces: `LabelSpec`, `LabelElement` (sealed), `LabelField`, `PrinterLanguage`, `PrinterDpi`; `mmToDots(mm: Double, dpi: Int): Int`, `ptToDots(pt: Double, dpi: Int): Int`, `ptToMm(pt: Double): Double`, `withPrinterDpi(spec: LabelSpec, dpi: Int?): LabelSpec`, `labelFieldDisplayValue(field, data, textFormat): String`, `needsImageRendering(text: String): Boolean`; `LabelSpecCodec.parse(json: String): LabelSpec`.

`LabelSpecCodec` has no production caller in this slice. It exists because the fixture test in Task 5 is a real consumer and because the aggregation slice reads the same JSON out of the shift bundle; writing it twice would be worse.

- [ ] **Step 1: Write the failing units test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelUnitsTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelUnitsTest {
    @Test
    fun millimetresConvertToDotsRoundingTiesUpward() {
        assertEquals(464, mmToDots(58.0, 203))
        assertEquals(320, mmToDots(40.0, 203))
        assertEquals(2, mmToDots(0.25, 203))
        // 0.0625 mm at 203 dpi is exactly 0.5 dots. JavaScript's Math.round gives 1, and so must this.
        assertEquals(1, mmToDots(0.0625, 203))
        // -0.0625 mm is exactly -0.5 dots, which rounds toward positive infinity, i.e. 0.
        assertEquals(0, mmToDots(-0.0625, 203))
        assertEquals(-12, mmToDots(-1.5, 203))
    }

    @Test
    fun pointsConvertToDotsAndMillimetres() {
        assertEquals(34, ptToDots(12.0, 203))
        assertEquals(50, ptToDots(12.0, 300))
        assertEquals(4.233333333333333, ptToMm(12.0), 1e-12)
    }

    @Test
    fun printerResolutionOverridesTheAuthoringOne() {
        val spec = LabelSpec(58.0, 40.0, 203, PrinterLanguage.ZPL, emptyList())
        assertTrue(spec === withPrinterDpi(spec, null))
        assertTrue(spec === withPrinterDpi(spec, 203))
        assertEquals(300, withPrinterDpi(spec, 300).dpi)
        assertEquals(58.0, withPrinterDpi(spec, 300).widthMm, 0.0)
    }

    @Test
    fun onlyPrintableAsciiStaysNative() {
        assertFalse(needsImageRendering("ACME Foods 04600682000013"))
        assertFalse(needsImageRendering(""))
        assertTrue(needsImageRendering("Вода"))
        assertTrue(needsImageRendering("café"))
        assertTrue(needsImageRendering("a\tb"))
        // Iterated by code point, so an astral character counts once and is out of range.
        assertTrue(needsImageRendering("😀"))
    }

    @Test
    fun fieldsAreFormattedForDisplay() {
        val data = mapOf(
            LabelField.SSCC to "346006820000000014",
            LabelField.QTY to "20",
            LabelField.PRODUCT_NAME to "Вода",
        )
        assertEquals("(00)346006820000000014", labelFieldDisplayValue(LabelField.SSCC, data, null))
        assertEquals("20 шт.", labelFieldDisplayValue(LabelField.QTY, data, null))
        assertEquals("Вода", labelFieldDisplayValue(LabelField.PRODUCT_NAME, data, null))
        assertEquals("", labelFieldDisplayValue(LabelField.OPERATOR, data, null))
        assertEquals("5 шт.", labelFieldDisplayValue(LabelField.QTY, mapOf(LabelField.QTY to "5 шт."), null))
        assertEquals("12 кг", labelFieldDisplayValue(LabelField.QTY, mapOf(LabelField.QTY to "12 кг"), null))
        // The crypto tail is dropped: the value becomes the application identifier, the GTIN, then
        // the serial identifier and the serial.
        assertEquals(
            "010460068200001321abcDEF1234567",
            labelFieldDisplayValue(
                LabelField.KM_CODE,
                mapOf(LabelField.KM_CODE to "010460068200001321abcDEF123456793ZZZZ"),
                TextFormat.KM_WITHOUT_CRYPTO,
            ),
        )
        assertEquals(
            "",
            labelFieldDisplayValue(LabelField.KM_CODE, mapOf(LabelField.KM_CODE to "nonsense"), TextFormat.KM_WITHOUT_CRYPTO),
        )
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

From `apps/handheld`:

```bash
./gradlew testDebugUnitTest --tests '*LabelUnitsTest' -q
```

Expected: FAIL to compile, `Unresolved reference: mmToDots`.

- [ ] **Step 3: Write the model**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpec.kt`:

```kotlin
package app.markiro.handheld.core.label

/**
 * Port of `packages/domain/src/labels/model.ts`. A spec is printer-neutral millimetre geometry;
 * the printer's language and resolution are applied at emit time, which is what lets one template
 * serve mixed printers. Every optional is nullable rather than defaulted: the TypeScript schema has
 * no `.default()` anywhere and the emitters branch on absence, so defaulting here changes output.
 */
enum class PrinterLanguage(val wire: String) {
    ZPL("zpl"),
    TSPL("tspl"),
    ;

    companion object {
        fun fromWire(value: String): PrinterLanguage =
            entries.firstOrNull { it.wire == value } ?: error("unknown printer language: $value")
    }
}

enum class LabelField(val wire: String) {
    PRODUCT_NAME("product.name"),
    PRODUCT_PRINT_NAME("product.printName"),
    PRODUCT_GTIN("product.gtin"),
    PRODUCT_EGAIS("product.egais"),
    KM_CODE("km.code"),
    SSCC("sscc"),
    SHIFT_NO("shift.no"),
    DATE("date"),
    EXPIRY("expiry"),
    QTY("qty"),
    OPERATOR("operator"),
    COUNTERPARTY_NAME("counterparty.name"),
    ;

    companion object {
        fun fromWire(value: String): LabelField =
            entries.firstOrNull { it.wire == value } ?: error("unknown label field: $value")
    }
}

enum class TextFormat(val wire: String) { KM_WITHOUT_CRYPTO("km_without_crypto") }

enum class LabelAlign(val wire: String) {
    LEFT("left"),
    CENTER("center"),
    RIGHT("right"),
    ;

    companion object {
        fun fromWire(value: String): LabelAlign =
            entries.firstOrNull { it.wire == value } ?: error("unknown align: $value")
    }
}

enum class BarcodeFormat(val wire: String) {
    DATAMATRIX("datamatrix"),
    CODE128("code128"),
    EAN13("ean13"),
    QR("qr"),
    ;

    companion object {
        fun fromWire(value: String): BarcodeFormat =
            entries.firstOrNull { it.wire == value } ?: error("unknown barcode format: $value")
    }
}

/** A barcode's payload: a field of the label data, or a literal the template author typed. */
sealed interface BarcodeSource {
    data class Field(val field: LabelField) : BarcodeSource
    data class Literal(val value: String) : BarcodeSource
}

sealed interface LabelElement {
    val id: String
    val xMm: Double
    val yMm: Double

    data class Text(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val text: String,
        val fontSizePt: Double,
        val bold: Boolean? = null,
        val align: LabelAlign? = null,
        val maxWidthMm: Double? = null,
        val maxLines: Int? = null,
    ) : LabelElement

    data class Field(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val field: LabelField,
        val textFormat: TextFormat? = null,
        val fontSizePt: Double,
        val bold: Boolean? = null,
        val align: LabelAlign? = null,
        val maxWidthMm: Double? = null,
        val maxLines: Int? = null,
    ) : LabelElement

    data class Barcode(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val format: BarcodeFormat,
        val data: BarcodeSource,
        /** Height for code128 and ean13; the module square side for datamatrix and qr. */
        val sizeMm: Double,
        val moduleWidthMm: Double? = null,
    ) : LabelElement

    data class Line(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val x2Mm: Double,
        val y2Mm: Double,
        val thicknessMm: Double,
    ) : LabelElement

    data class Box(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val widthMm: Double,
        val heightMm: Double,
        val thicknessMm: Double,
    ) : LabelElement
}

data class LabelSpec(
    val widthMm: Double,
    val heightMm: Double,
    /** 203 or 300. */
    val dpi: Int,
    val language: PrinterLanguage,
    val elements: List<LabelElement>,
)

/** Raised when a template asks for something this device cannot render. */
class LabelRenderException(message: String) : Exception(message)
```

Text and field share five properties but are separate data classes on purpose, mirroring the TypeScript discriminated union: a `field` carries `textFormat` and a `text` does not, and an exhaustive `when` over the sealed interface is what keeps the emitters from silently ignoring a kind.

- [ ] **Step 4: Write the units and field formatting**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelUnits.kt`:

```kotlin
package app.markiro.handheld.core.label

import app.markiro.handheld.core.km.KmCodec
import kotlin.math.roundToInt

private const val MM_PER_INCH = 25.4
private const val POINTS_PER_INCH = 72.0

/** «шт.» — the unit the domain package appends to a numeric quantity. */
const val QTY_UNIT_SUFFIX = "шт."

/**
 * `round(mm * dpi / 25.4)`, matching `mmToDots` in packages/domain/src/labels/model.ts.
 *
 * `roundToInt` is required: it rounds ties toward positive infinity exactly as JavaScript's
 * `Math.round` does. `kotlin.math.round` rounds ties to even and would move coordinates by a dot.
 * Coordinates may be negative, so the tie direction is observable.
 */
fun mmToDots(mm: Double, dpi: Int): Int = (mm * dpi / MM_PER_INCH).roundToInt()

/** `round(pt / 72 * dpi)`, matching `ptToDots` in the same module. */
fun ptToDots(pt: Double, dpi: Int): Int = (pt / POINTS_PER_INCH * dpi).roundToInt()

/** `pt / 72 * 25.4`, matching `ptToMm` in packages/domain/src/labels/wrap.ts. */
fun ptToMm(pt: Double): Double = pt / POINTS_PER_INCH * MM_PER_INCH

/**
 * The printer's resolution wins over the template's authoring resolution. Returns the same instance
 * when there is nothing to change, matching the TypeScript identity guarantee.
 */
fun withPrinterDpi(spec: LabelSpec, printerDpi: Int?): LabelSpec =
    if (printerDpi == null || printerDpi == spec.dpi) spec else spec.copy(dpi = printerDpi)

/**
 * True when any code point falls outside printable ASCII, matching `needsImageRendering` in
 * packages/domain/src/labels/text.ts. Deliberately ASCII-only rather than Latin-1: native emission
 * of bytes above 0x7F depends on the printer's active code page, which cannot be verified here.
 *
 * Iterates by code point so an astral character counts once instead of as two surrogate halves.
 */
fun needsImageRendering(text: String): Boolean {
    var index = 0
    while (index < text.length) {
        val code = text.codePointAt(index)
        if (code < 0x20 || code > 0x7e) return true
        index += Character.charCount(code)
    }
    return false
}

private val DIGITS = Regex("^\\d+$")
private val SSCC_18 = Regex("^\\d{18}$")

/**
 * Port of `labelFieldDisplayValue` in packages/domain/src/labels/model.ts. The single display
 * formatting layer both emitters share. Every rule is tolerant: malformed input passes through
 * rather than throwing, because a label must still print.
 */
fun labelFieldDisplayValue(
    field: LabelField,
    data: Map<LabelField, String>,
    textFormat: TextFormat?,
): String {
    val value = data[field] ?: ""
    if (field == LabelField.KM_CODE && textFormat == TextFormat.KM_WITHOUT_CRYPTO) {
        val km = runCatching { KmCodec.canonicalize(value) }.getOrNull() ?: return ""
        return "01${km.gtin14}21${km.serial}"
    }
    if (field == LabelField.SSCC && SSCC_18.matches(value)) return "(00)$value"
    if (field == LabelField.QTY) {
        val digits = value.trim()
        if (DIGITS.matches(digits)) return "$digits $QTY_UNIT_SUFFIX"
    }
    return value
}
```

- [ ] **Step 5: Run the units test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*LabelUnitsTest' -q
```

Expected: PASS.

- [ ] **Step 6: Write the spec parser**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpecCodec.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Reads a label template spec from the JSON the cabinet stores. Consumed by the fixture test now;
 * the aggregation slice feeds it the shift bundle's box template.
 */
object LabelSpecCodec {
    fun parse(json: String): LabelSpec = spec(Json.parseToJsonElement(json).jsonObject)

    fun spec(o: JsonObject): LabelSpec = LabelSpec(
        widthMm = o.num("widthMm"),
        heightMm = o.num("heightMm"),
        dpi = o.int("dpi"),
        language = PrinterLanguage.fromWire(o.str("language")),
        elements = o.getValue("elements").jsonArray.map { element(it.jsonObject) },
    )

    private fun element(o: JsonObject): LabelElement = when (val kind = o.str("kind")) {
        "text" -> LabelElement.Text(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"), text = o.str("text"),
            fontSizePt = o.num("fontSizePt"), bold = o.boolOrNull("bold"),
            align = o.strOrNull("align")?.let(LabelAlign::fromWire),
            maxWidthMm = o.numOrNull("maxWidthMm"), maxLines = o.intOrNull("maxLines"),
        )
        "field" -> LabelElement.Field(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            field = LabelField.fromWire(o.str("field")),
            textFormat = o.strOrNull("textFormat")?.let { TextFormat.KM_WITHOUT_CRYPTO },
            fontSizePt = o.num("fontSizePt"), bold = o.boolOrNull("bold"),
            align = o.strOrNull("align")?.let(LabelAlign::fromWire),
            maxWidthMm = o.numOrNull("maxWidthMm"), maxLines = o.intOrNull("maxLines"),
        )
        "barcode" -> LabelElement.Barcode(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            format = BarcodeFormat.fromWire(o.str("format")),
            data = o.getValue("data").let { element ->
                if (element is JsonObject) BarcodeSource.Literal(element.str("literal"))
                else BarcodeSource.Field(LabelField.fromWire(element.jsonPrimitive.content))
            },
            sizeMm = o.num("sizeMm"), moduleWidthMm = o.numOrNull("moduleWidthMm"),
        )
        "line" -> LabelElement.Line(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            x2Mm = o.num("x2Mm"), y2Mm = o.num("y2Mm"), thicknessMm = o.num("thicknessMm"),
        )
        "box" -> LabelElement.Box(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            widthMm = o.num("widthMm"), heightMm = o.num("heightMm"), thicknessMm = o.num("thicknessMm"),
        )
        else -> throw LabelRenderException("unknown label element kind: $kind")
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.strOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.num(key: String) = getValue(key).jsonPrimitive.doubleOrNull ?: 0.0
    private fun JsonObject.numOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.doubleOrNull
    private fun JsonObject.int(key: String) = getValue(key).jsonPrimitive.intOrNull ?: 0
    private fun JsonObject.intOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.intOrNull
    private fun JsonObject.boolOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.booleanOrNull
}
```

- [ ] **Step 7: Run the gate**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

- [ ] **Step 8: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label
git commit -m "feat(handheld): label spec model, unit conversion and field formatting"
```

---

### Task 3: Text wrapping and the shared alignment offset

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TextWrap.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TextWrapTest.kt`

**Interfaces:**

- Consumes: `ptToMm` from Task 2.
- Produces: `wrapTextToWidth(text: String, measure: (String) -> Double, maxWidth: Double, maxLines: Int = 1): List<String>`, `clipWithEllipsis(text: String, measure: (String) -> Double, maxWidth: Double): String`, `estimatedTextWidthMm(text: String, fontSizePt: Double): Double`, `rasterAlignOffsetDots(align: LabelAlign?, maxWidthDots: Int?, contentWidthDots: Int): Int`, `WRAP_ELLIPSIS`, `AVG_CHAR_WIDTH_EM`, `LINE_HEIGHT_EM`.

Measurement is injected because this code has two callers with two different units. The native path measures in millimetres with the character-count estimate; the raster path measures in printer dots with a real font. Same algorithm, both.

`rasterAlignOffsetDots` is the single definition of what alignment means in dots. Both emitters' image branches and the TSPL native branch call it. Do not reimplement it per emitter.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TextWrapTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import org.junit.Assert.assertEquals
import org.junit.Test

class TextWrapTest {
    /** One unit per code point keeps the expectations readable. */
    private val perChar: (String) -> Double = { it.codePointCount(0, it.length).toDouble() }

    @Test
    fun greedyWrapBreaksOnWhitespace() {
        assertEquals(listOf("ab cd", "ef"), wrapTextToWidth("ab cd ef", perChar, 5.0, 4))
    }

    @Test
    fun whitespaceRunsCollapseAndEdgesAreTrimmed() {
        assertEquals(listOf("ab", "cd"), wrapTextToWidth("  ab   cd  ", perChar, 2.0, 4))
    }

    @Test
    fun anUnbreakableWordIsChunked() {
        assertEquals(listOf("abc", "def", "g"), wrapTextToWidth("abcdefg", perChar, 3.0, 4))
    }

    @Test
    fun theLastKeptLineIsEllipsizedOnlyWhenContentWasDropped() {
        assertEquals(listOf("ab", "cd"), wrapTextToWidth("ab cd", perChar, 2.0, 2))
        assertEquals(listOf("ab", "c…"), wrapTextToWidth("ab cd ef", perChar, 2.0, 2))
    }

    @Test
    fun aNonPositiveWidthReturnsTheTextUnwrapped() {
        assertEquals(listOf("ab cd"), wrapTextToWidth("ab cd", perChar, 0.0, 3))
        assertEquals(listOf("ab cd"), wrapTextToWidth("ab cd", perChar, Double.NaN, 3))
    }

    @Test
    fun whitespaceOnlyInputComesBackVerbatim() {
        assertEquals(listOf("   "), wrapTextToWidth("   ", perChar, 5.0, 2))
    }

    @Test
    fun clippingFallsBackToNothingWhenEvenTheEllipsisDoesNotFit() {
        assertEquals("", clipWithEllipsis("abcd", perChar, 0.5))
        assertEquals("abc…", clipWithEllipsis("abcdef", perChar, 4.0))
    }

    @Test
    fun anEmptyStringIsOneCharacterWide() {
        assertEquals(estimatedTextWidthMm("a", 12.0), estimatedTextWidthMm("", 12.0), 1e-12)
    }

    @Test
    fun alignmentOffsetsAreClampedAndNeedABox() {
        assertEquals(0, rasterAlignOffsetDots(LabelAlign.CENTER, null, 16))
        assertEquals(72, rasterAlignOffsetDots(LabelAlign.CENTER, 160, 16))
        assertEquals(144, rasterAlignOffsetDots(LabelAlign.RIGHT, 160, 16))
        assertEquals(0, rasterAlignOffsetDots(LabelAlign.LEFT, 160, 16))
        assertEquals(0, rasterAlignOffsetDots(null, 160, 16))
        assertEquals(0, rasterAlignOffsetDots(LabelAlign.RIGHT, 160, 200))
        assertEquals(0, rasterAlignOffsetDots(LabelAlign.CENTER, 160, 200))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*TextWrapTest' -q
```

Expected: FAIL to compile, `Unresolved reference: wrapTextToWidth`.

- [ ] **Step 3: Write the implementation**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TextWrap.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/** U+2026, one code point. */
const val WRAP_ELLIPSIS = "…"
const val AVG_CHAR_WIDTH_EM = 0.55
const val LINE_HEIGHT_EM = 1.5

/**
 * JavaScript's `\s` covers more than Java's default: no-break space, the Unicode space separators,
 * the line and paragraph separators and the byte-order mark. Spelling the class out keeps a product
 * name containing a no-break space wrapping the same way on both sides.
 */
private val WHITESPACE = Regex("[ \\t\\n\\u000B\\u000C\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

/** `max(len, 1) * ptToMm(pt) * 0.55`. The floor of one is deliberate: an empty string is not zero wide. */
fun estimatedTextWidthMm(text: String, fontSizePt: Double): Double =
    max(text.length, 1) * ptToMm(fontSizePt) * AVG_CHAR_WIDTH_EM

/**
 * The longest prefix that still fits once the ellipsis is appended. Returns an empty string, with no
 * marker at all, when even the bare ellipsis does not fit.
 */
fun clipWithEllipsis(text: String, measure: (String) -> Double, maxWidth: Double): String {
    if (measure(WRAP_ELLIPSIS) > maxWidth) return ""
    var lo = 0
    var hi = text.length
    while (lo < hi) {
        // The upper mid is load-bearing: a floor mid makes this loop spin forever.
        val mid = ceil((lo + hi) / 2.0).toInt()
        if (measure(text.substring(0, mid) + WRAP_ELLIPSIS) <= maxWidth) lo = mid else hi = mid - 1
    }
    return text.substring(0, lo) + WRAP_ELLIPSIS
}

/** Greedy character accumulation for a word wider than the box. Iterates by code point. */
private fun breakLongWord(word: String, measure: (String) -> Double, maxWidth: Double): List<String> {
    val chunks = ArrayList<String>()
    var current = StringBuilder()
    var index = 0
    while (index < word.length) {
        val count = Character.charCount(word.codePointAt(index))
        val ch = word.substring(index, index + count)
        if (current.isNotEmpty() && measure(current.toString() + ch) > maxWidth) {
            chunks += current.toString()
            current = StringBuilder(ch)
        } else {
            current.append(ch)
        }
        index += count
    }
    if (current.isNotEmpty()) chunks += current.toString()
    return chunks.ifEmpty { listOf(word) }
}

/**
 * Port of `wrapTextToWidth` in packages/domain/src/labels/wrap.ts. `maxLines` defaults to one, and
 * one line means one line clipped, not no wrapping. The ellipsis appears only when a line was
 * actually dropped.
 */
fun wrapTextToWidth(
    text: String,
    measure: (String) -> Double,
    maxWidth: Double,
    maxLines: Int = 1,
): List<String> {
    if (!maxWidth.isFinite() || maxWidth <= 0.0) return listOf(text)
    val limit = max(1, maxLines)
    val words = text.split(WHITESPACE).filter { it.isNotEmpty() }
    if (words.isEmpty()) return listOf(text)

    val lines = ArrayList<String>()
    var current = ""
    for (word in words) {
        val candidate = if (current.isEmpty()) word else "$current $word"
        if (measure(candidate) <= maxWidth) {
            current = candidate
            continue
        }
        if (current.isNotEmpty()) lines += current
        if (measure(word) <= maxWidth) {
            current = word
            continue
        }
        val chunks = breakLongWord(word, measure, maxWidth)
        lines += chunks.dropLast(1)
        current = chunks.lastOrNull() ?: ""
    }
    if (current.isNotEmpty()) lines += current
    if (lines.isEmpty()) return listOf("")
    if (lines.size <= limit) return lines
    val kept = ArrayList(lines.subList(0, limit))
    kept[limit - 1] = clipWithEllipsis(kept[limit - 1], measure, maxWidth)
    return kept
}

/**
 * What `align` means in dots, for both emitters' image branches and the TSPL native branch. With no
 * box there is nothing to align against and the offset is zero whatever the alignment says, which
 * mirrors ZPL emitting no field block. Both branches clamp at zero so content wider than its box
 * stays anchored rather than running off the left edge.
 */
fun rasterAlignOffsetDots(align: LabelAlign?, maxWidthDots: Int?, contentWidthDots: Int): Int {
    if (maxWidthDots == null) return 0
    val leftover = maxWidthDots - contentWidthDots
    return when (align) {
        LabelAlign.CENTER -> max(0, (leftover / 2.0).roundToInt())
        LabelAlign.RIGHT -> max(0, leftover)
        else -> 0
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*TextWrapTest' -q
```

Expected: PASS.

- [ ] **Step 5: Run the gate**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TextWrap.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TextWrapTest.kt
git commit -m "feat(handheld): label text wrapping and the shared alignment offset"
```

---

### Task 4: Monochrome conversion, bit packing and the image commands

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/RasterizeText.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/Monochrome.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/MonochromeTest.kt`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `RasterResult(hex, totalBytes, bytesPerRow, width, height)`, `RasterOptions(fontFamily, fontSizePx, bold, maxWidthPx, maxLines)`, `fun interface RasterizeText { suspend fun rasterize(text: String, options: RasterOptions): RasterResult }`; `convertToMonochrome(argb: IntArray, width: Int, height: Int): ByteArray`, `bitmapToZplHex(bitmap: ByteArray, width: Int, height: Int): ZplPacking`, `buildGfaCommand(r: RasterResult): String`, `tsplBitmapBytes(hex: String): ByteArray`, `buildBitmapCommand(x: Int, y: Int, r: RasterResult, out: ByteArrayOutputStream)`.

Two facts drive this file. The two languages use opposite polarity: a set bit is black in ZPL and white in TSPL. And the TSPL payload is raw bytes, so its command is written to a byte stream rather than returned as a string.

`RasterResult.width` is the logical pixel width and is not recoverable from the packing, because rows are padded to whole bytes. Alignment depends on it, so it is carried separately.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/MonochromeTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

class MonochromeTest {
    private fun argb(vararg pixels: Int) = IntArray(pixels.size) { pixels[it] }

    private val black = 0xFF000000.toInt()
    private val white = 0xFFFFFFFF.toInt()

    @Test
    fun luminanceIsThresholdedWithNoDithering() {
        // Exactly 127 grey is black: the comparison is strictly greater than 127.
        val grey127 = 0xFF7F7F7F.toInt()
        val grey128 = 0xFF808080.toInt()
        assertArrayEquals(byteArrayOf(1, 0, 1, 0), convertToMonochrome(argb(black, white, grey127, grey128), 4, 1))
    }

    @Test
    fun channelsAreReadUnsigned() {
        // A blue channel of 0xFF must not read as negative; pure blue is dark and stays black.
        assertArrayEquals(byteArrayOf(1), convertToMonochrome(argb(0xFF0000FF.toInt()), 1, 1))
        // Pure green is bright enough to be white under the BT.601 weights.
        assertArrayEquals(byteArrayOf(0), convertToMonochrome(argb(0xFF00FF00.toInt()), 1, 1))
    }

    @Test
    fun bitsPackMostSignificantFirstAndRowsPadToWholeBytes() {
        // Nine pixels: the first is black, the rest white. Row is two bytes, second byte all padding.
        val bitmap = ByteArray(9).also { it[0] = 1 }
        val packed = bitmapToZplHex(bitmap, 9, 1)
        assertEquals("8000", packed.hex)
        assertEquals(2, packed.bytesPerRow)
        assertEquals(2, packed.totalBytes)
    }

    @Test
    fun theZplCommandCarriesTheByteCountsAndRowStride() {
        val r = RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
        assertEquals("^GFA,4,4,2,AAAA5555", buildGfaCommand(r))
    }

    @Test
    fun tsplInvertsEveryBitIncludingPadding() {
        assertArrayEquals(
            byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()),
            tsplBitmapBytes("AAAA5555"),
        )
    }

    @Test
    fun theTsplCommandWritesParametersThenRawBytes() {
        val r = RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
        val out = ByteArrayOutputStream()
        buildBitmapCommand(40, 40, r, out)
        val bytes = out.toByteArray()
        assertEquals("BITMAP 40,40,2,2,0,", String(bytes, 0, 19, Charsets.US_ASCII))
        assertArrayEquals(byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()), bytes.copyOfRange(19, bytes.size))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*MonochromeTest' -q
```

Expected: FAIL to compile, `Unresolved reference: convertToMonochrome`.

- [ ] **Step 3: Write the rasterizer contract**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/RasterizeText.kt`:

```kotlin
package app.markiro.handheld.core.label

/**
 * A rasterized text run, in ZPL polarity: a set bit is black. Rows are padded to whole bytes, so
 * `width` is not `bytesPerRow * 8` and cannot be recovered from the packing. Alignment needs the
 * logical width, which is why it is carried here.
 */
data class RasterResult(
    /** Uppercase ASCII hex, no separators, rows concatenated. */
    val hex: String,
    val totalBytes: Int,
    val bytesPerRow: Int,
    val width: Int,
    val height: Int,
)

/**
 * `maxWidthPx` is a contract, not a hint: the returned bitmap must not be wider. An implementation
 * satisfies it by wrapping up to `maxLines` lines and clipping the last. Without that, a long
 * Cyrillic name prints off the right edge of the label.
 */
data class RasterOptions(
    val fontFamily: String,
    val fontSizePx: Int,
    val bold: Boolean,
    val maxWidthPx: Int?,
    val maxLines: Int,
)

fun interface RasterizeText {
    suspend fun rasterize(text: String, options: RasterOptions): RasterResult
}
```

- [ ] **Step 4: Write the pixel code**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/Monochrome.kt`:

```kotlin
package app.markiro.handheld.core.label

import java.io.ByteArrayOutputStream

data class ZplPacking(val hex: String, val totalBytes: Int, val bytesPerRow: Int)

/**
 * Port of `convertToMonochrome` in packages/domain/src/labels/raster.ts. One byte per pixel, 1 for
 * black. BT.601 luminance in floating point, then a hard threshold with no dithering; exactly 127
 * is black. Alpha is ignored, matching the original, so callers must draw onto an opaque background.
 *
 * Channels are masked to unsigned. Reading a channel of 0x80 or more as a signed byte would invert
 * the image.
 */
fun convertToMonochrome(argb: IntArray, width: Int, height: Int): ByteArray {
    val out = ByteArray(width * height)
    val count = minOf(argb.size, out.size)
    for (i in 0 until count) {
        val pixel = argb[i]
        val r = (pixel shr 16) and 0xFF
        val g = (pixel shr 8) and 0xFF
        val b = pixel and 0xFF
        val grey = 0.299 * r + 0.587 * g + 0.114 * b
        out[i] = if (grey > 127.0) 0 else 1
    }
    return out
}

/**
 * Port of `bitmapToZplHex` in the same module. Row major, top row first, most significant bit is the
 * leftmost pixel of its byte. Rows pad to whole bytes and the padding bits stay zero, which is white
 * in ZPL polarity.
 */
fun bitmapToZplHex(bitmap: ByteArray, width: Int, height: Int): ZplPacking {
    val bytesPerRow = (width + 7) / 8
    val hex = StringBuilder(bytesPerRow * height * 2)
    for (y in 0 until height) {
        for (x in 0 until bytesPerRow) {
            var byte = 0
            for (bit in 0 until 8) {
                val pixelX = x * 8 + bit
                if (pixelX < width) {
                    val index = y * width + pixelX
                    if (index < bitmap.size && bitmap[index].toInt() == 1) byte = byte or (1 shl (7 - bit))
                }
            }
            hex.append(HEX[(byte shr 4) and 0xF]).append(HEX[byte and 0xF])
        }
    }
    return ZplPacking(hex.toString(), bytesPerRow * height, bytesPerRow)
}

private const val HEX = "0123456789ABCDEF"

/** `^GFA,<binaryBytes>,<graphicBytes>,<bytesPerRow>,<hex>`. The caller supplies the origin and the field separator. */
fun buildGfaCommand(r: RasterResult): String = "^GFA,${r.totalBytes},${r.totalBytes},${r.bytesPerRow},${r.hex}"

/**
 * The one place polarity is flipped. ZPL sets a bit for black; TSPL's overwrite mode sets a bit for
 * white. Every bit is inverted, including the row padding, so padding that was white under one
 * convention stays white under the other.
 */
fun tsplBitmapBytes(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        val value = hex.substring(i * 2, i * 2 + 2).toInt(16)
        out[i] = (value xor 0xFF).toByte()
    }
    return out
}

/**
 * `BITMAP x,y,<widthInBytes>,<heightInDots>,<mode 0>,<raw bytes>`. The payload is binary and runs to
 * the end of the line, so this writes into the document stream rather than returning a string.
 */
fun buildBitmapCommand(x: Int, y: Int, r: RasterResult, out: ByteArrayOutputStream) {
    out.write("BITMAP $x,$y,${r.bytesPerRow},${r.height},0,".toByteArray(Charsets.US_ASCII))
    out.write(tsplBitmapBytes(r.hex))
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*MonochromeTest' -q
```

Expected: PASS.

- [ ] **Step 6: Run the gate**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label
git commit -m "feat(handheld): monochrome conversion, bit packing and the printer image commands"
```

---

### Task 5: The ZPL emitter

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/ZplEmitterTest.kt`

**Interfaces:**

- Consumes: everything from Tasks 2, 3 and 4.
- Produces: `suspend fun generateZpl(spec: LabelSpec, data: Map<LabelField, String>, rasterize: RasterizeText?): String`.

Reference: `packages/domain/src/labels/zpl.ts`. Transcribe it; the invariants below are the ones a careless port loses.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/ZplEmitterTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZplEmitterTest {
    private val data = mapOf(
        LabelField.PRODUCT_GTIN to "04600682000013",
        LabelField.SSCC to "346006820000000014",
        LabelField.PRODUCT_NAME to "Вода",
    )

    private fun spec(vararg elements: LabelElement) =
        LabelSpec(58.0, 40.0, 203, PrinterLanguage.ZPL, elements.toList())

    private val stub = RasterizeText { _, options ->
        val width = options.maxWidthPx ?: 16
        RasterResult(hex = "AAAA", totalBytes = 2, bytesPerRow = 2, width = width, height = 8)
    }

    @Test
    fun theDocumentIsFramedAndEndsWithANewline() = runTest {
        val document = generateZpl(spec(), data, null)
        assertEquals("^XA\n^PW464\n^LL320\n^XZ\n", document)
    }

    @Test
    fun nativeTextUsesTheScalableFontAtBothAxes() = runTest {
        val document = generateZpl(
            spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0)),
            data,
            null,
        )
        assertTrue(document.contains("^FO16,16^A0N,34,34^FDACME^FS"))
        assertFalse(document.contains("^FH"))
        assertFalse(document.contains("^FB"))
    }

    @Test
    fun aBoxedTextEmitsAFieldBlockWithItsJustification() = runTest {
        val document = generateZpl(
            spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0, maxWidthMm = 40.0, maxLines = 2, align = LabelAlign.CENTER)),
            data,
            null,
        )
        assertTrue(document.contains("^FO16,16^A0N,34,34^FB320,2,0,C,0^FDACME^FS"))
    }

    @Test
    fun onlyTheThreeControlCharactersAreEscaped() = runTest {
        val document = generateZpl(spec(LabelElement.Text("t1", 2.0, 2.0, "A^B~C_D", 10.0)), data, null)
        assertTrue(document.contains("^FH_^FDA_5EB_7EC_5FD^FS"))
    }

    @Test
    fun anSsccBarcodeCarriesTheApplicationIdentifierAndItsModuleWidth() = runTest {
        val document = generateZpl(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC), 15.0, 0.25)),
            data,
            null,
        )
        assertTrue(document.contains("^FO32,96^BY2^BCN,120,N,N,N^FD>;>800346006820000000014^FS"))
    }

    @Test
    fun aLiteralBarcodeGetsNoApplicationIdentifierAndNoBarWidth() = runTest {
        val document = generateZpl(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Literal("ABC"), 10.0)),
            data,
            null,
        )
        assertTrue(document.contains("^FO32,96^BCN,80,N,N,N^FDABC^FS"))
        assertFalse(document.contains("^BY"))
    }

    @Test
    fun aReversedLineIsAnchoredAtItsLeftmostEnd() = runTest {
        val document = generateZpl(
            spec(LabelElement.Line("l1", 40.0, 30.0, 10.0, 30.0, 0.5)),
            data,
            null,
        )
        assertTrue(document.contains("^FO80,240^GB240,4,4^FS"))
    }

    @Test
    fun cyrillicGoesThroughTheImageBranchAndShiftsForAlignment() = runTest {
        val document = generateZpl(
            spec(LabelElement.Field("f1", 5.0, 5.0, LabelField.PRODUCT_NAME, fontSizePt = 12.0, maxWidthMm = 20.0, align = LabelAlign.RIGHT)),
            data,
            stub,
        )
        // The box is 160 dots and the stub returns a bitmap of that width, so the offset is zero.
        assertTrue(document.contains("^FO40,40^GFA,2,2,2,AAAA^FS"))
    }

    @Test
    fun cyrillicWithoutARasterizerIsRefusedByName() = runTest {
        val failure = runCatching {
            generateZpl(spec(LabelElement.Field("f1", 2.0, 2.0, LabelField.PRODUCT_NAME, fontSizePt = 10.0)), data, null)
        }.exceptionOrNull()
        assertTrue(failure is LabelRenderException)
        assertTrue(failure!!.message!!.contains("Вода"))
    }

    @Test
    fun matrixAndEanFormatsAreRefusedByName() = runTest {
        for (format in listOf(BarcodeFormat.DATAMATRIX, BarcodeFormat.QR, BarcodeFormat.EAN13)) {
            val failure = runCatching {
                generateZpl(
                    spec(LabelElement.Barcode("b1", 2.0, 2.0, format, BarcodeSource.Literal("X"), 10.0)),
                    data,
                    null,
                )
            }.exceptionOrNull()
            assertTrue(format.wire, failure is LabelRenderException)
            assertTrue(format.wire, failure!!.message!!.contains(format.wire))
        }
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*ZplEmitterTest' -q
```

Expected: FAIL to compile, `Unresolved reference: generateZpl`.

- [ ] **Step 3: Write the emitter**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val HEX_INDICATOR = "_"

/**
 * Port of `generateZpl` in packages/domain/src/labels/zpl.ts.
 *
 * Elements are rendered strictly in order, one after another rather than concurrently, so the
 * document order does not depend on how fast an individual rasterization finishes.
 *
 * Several branches deliberately emit nothing, and each one is what keeps output byte-identical to
 * the original for templates written before the feature existed: no hex-escape prefix when no
 * control character occurs, no bar-width command when the template sets no module width, and a
 * field block only when the element carries a box.
 */
suspend fun generateZpl(
    spec: LabelSpec,
    data: Map<LabelField, String>,
    rasterize: RasterizeText?,
): String {
    val lines = ArrayList<String>()
    lines += "^XA"
    lines += "^PW${mmToDots(spec.widthMm, spec.dpi)}"
    lines += "^LL${mmToDots(spec.heightMm, spec.dpi)}"
    for (element in spec.elements) {
        lines += when (element) {
            is LabelElement.Text -> textLike(
                spec, element.xMm, element.yMm, element.text, element.fontSizePt, element.bold,
                element.align, element.maxWidthMm, element.maxLines, rasterize,
            )
            is LabelElement.Field -> textLike(
                spec, element.xMm, element.yMm,
                labelFieldDisplayValue(element.field, data, element.textFormat),
                element.fontSizePt, element.bold, element.align, element.maxWidthMm, element.maxLines, rasterize,
            )
            is LabelElement.Barcode -> barcode(spec, element, data)
            is LabelElement.Line -> line(spec, element)
            is LabelElement.Box -> box(spec, element)
        }
    }
    lines += "^XZ"
    return lines.joinToString("\n") + "\n"
}

/** `^`, `~` and `_` are ZPL's own control characters and must be sent as hex escapes. */
private fun escapeFieldData(text: String): Pair<String, String> {
    if (text.none { it == '^' || it == '~' || it == '_' }) return "" to text
    val escaped = buildString {
        for (ch in text) {
            if (ch == '^' || ch == '~' || ch == '_') {
                append(HEX_INDICATOR).append(ch.code.toString(16).uppercase().padStart(2, '0'))
            } else {
                append(ch)
            }
        }
    }
    return "^FH$HEX_INDICATOR" to escaped
}

private suspend fun textLike(
    spec: LabelSpec,
    xMm: Double,
    yMm: Double,
    text: String,
    fontSizePt: Double,
    bold: Boolean?,
    align: LabelAlign?,
    maxWidthMm: Double?,
    maxLines: Int?,
    rasterize: RasterizeText?,
): String {
    val x = mmToDots(xMm, spec.dpi)
    val y = mmToDots(yMm, spec.dpi)
    val maxWidthDots = maxWidthMm?.let { mmToDots(it, spec.dpi) }
    if (needsImageRendering(text)) {
        if (rasterize == null) {
            throw LabelRenderException(
                "label text \"$text\" contains characters outside printable ASCII and needs image rendering, " +
                    "but no rasterizer was provided",
            )
        }
        val raster = rasterize.rasterize(
            text,
            RasterOptions(
                fontFamily = "sans-serif",
                fontSizePx = ptToDots(fontSizePt, spec.dpi),
                bold = bold ?: false,
                maxWidthPx = maxWidthDots,
                maxLines = maxLines ?: 1,
            ),
        )
        val offset = rasterAlignOffsetDots(align, maxWidthDots, raster.width)
        return "^FO${x + offset},$y${buildGfaCommand(raster)}^FS"
    }
    // The scalable font takes the same value for height and width. `bold` has no effect here: font
    // zero carries no weight parameter, so boldness is honoured on the image branch only.
    val height = ptToDots(fontSizePt, spec.dpi)
    val font = "^A0N,$height,$height"
    val (fh, payload) = escapeFieldData(text)
    if (maxWidthDots == null) return "^FO$x,$y$font$fh^FD$payload^FS"
    val justification = when (align) {
        LabelAlign.CENTER -> "C"
        LabelAlign.RIGHT -> "R"
        else -> "L"
    }
    val block = "^FB$maxWidthDots,${maxLines ?: 1},0,$justification,0"
    return "^FO$x,$y$font$block$fh^FD$payload^FS"
}

private fun barcode(spec: LabelSpec, element: LabelElement.Barcode, data: Map<LabelField, String>): String {
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val value = when (val source = element.data) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    // The application identifier is added here and nowhere else: storage and transport carry a bare
    // eighteen-digit code. `>;` selects subset C and `>8` is the printer's own GS1 flag.
    val gs1 = element.data is BarcodeSource.Field && (element.data as BarcodeSource.Field).field == LabelField.SSCC
    val payload = if (gs1) ">;>800$value" else value
    // The bar-width command is modal on a real printer and survives into the next label, so it is
    // pinned immediately before its own barcode rather than set once per document.
    val barWidth = element.moduleWidthMm?.let { "^BY${max(1, min(10, mmToDots(it, spec.dpi)))}" } ?: ""
    val (fh, escaped) = escapeFieldData(payload)
    // The interpretation line is off on purpose, matching the other language, so one template does
    // not print differently depending on the printer brand.
    return "^FO$x,$y$barWidth^BCN,${mmToDots(element.sizeMm, spec.dpi)},N,N,N$fh^FD$escaped^FS"
}

private fun line(spec: LabelSpec, element: LabelElement.Line): String {
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    // The span rounds the difference in millimetres. Subtracting two already-rounded dot values can
    // differ by one dot, so do not simplify this.
    val spanX = mmToDots(abs(element.x2Mm - element.xMm), spec.dpi)
    val spanY = mmToDots(abs(element.y2Mm - element.yMm), spec.dpi)
    val originX = mmToDots(min(element.xMm, element.x2Mm), spec.dpi)
    val originY = mmToDots(min(element.yMm, element.y2Mm), spec.dpi)
    // A line drawn right to left still anchors at its leftmost end, and each axis is clamped up to
    // the thickness so a horizontal line never becomes a zero-height box.
    return "^FO$originX,$originY^GB${max(spanX, thickness)},${max(spanY, thickness)},$thickness^FS"
}

private fun box(spec: LabelSpec, element: LabelElement.Box): String {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val width = mmToDots(element.widthMm, spec.dpi)
    val height = mmToDots(element.heightMm, spec.dpi)
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    return "^FO$x,$y^GB$width,$height,$thickness^FS"
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*ZplEmitterTest' -q
```

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/ZplEmitterTest.kt
git commit -m "feat(handheld): ZPL emitter"
```

---

### Task 6: The TSPL emitter

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TsplEmitterTest.kt`

**Interfaces:**

- Consumes: everything from Tasks 2, 3 and 4.
- Produces: `suspend fun generateTspl(spec: LabelSpec, data: Map<LabelField, String>, rasterize: RasterizeText?): ByteArray`.

Reference: `packages/domain/src/labels/tspl.ts`. Four things differ from the other language and each one is a trap:

- The page size command takes millimetres. Everything else takes dots.
- The font size goes through unconverted. The internal scalable font reads those two slots as points, which is the unit the model already uses. Only coordinates convert to dots.
- The document contains raw bytes, so it is built as a byte stream. A number formatted through Kotlin's default `Double` rendering would also write `58.0` where the original writes `58`.
- Alignment is computed here rather than delegated, on the native branch as well, and applied per line. The language does have an alignment parameter, but it aligns about the command's own origin with no width, which would push a centred string half off the label.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TsplEmitterTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TsplEmitterTest {
    private val data = mapOf(
        LabelField.PRODUCT_GTIN to "04600682000013",
        LabelField.SSCC to "346006820000000014",
        LabelField.PRODUCT_NAME to "Вода",
    )

    private fun spec(vararg elements: LabelElement, dpi: Int = 203) =
        LabelSpec(58.0, 40.0, dpi, PrinterLanguage.TSPL, elements.toList())

    private suspend fun text(spec: LabelSpec, rasterize: RasterizeText? = null) =
        String(generateTspl(spec, data, rasterize), Charsets.ISO_8859_1)

    private val stub = RasterizeText { _, _ ->
        RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
    }

    @Test
    fun theDocumentIsFramedWithMillimetresAndEndsWithANewline() = runTest {
        assertEquals("SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nPRINT 1\n", text(spec()))
    }

    @Test
    fun aFractionalPageSizeKeepsItsDecimalAndAWholeOneDoesNot() = runTest {
        val document = String(
            generateTspl(LabelSpec(57.5, 40.0, 203, PrinterLanguage.TSPL, emptyList()), data, null),
            Charsets.ISO_8859_1,
        )
        assertTrue(document.startsWith("SIZE 57.5 mm, 40 mm\n"))
    }

    @Test
    fun theFontSizeIsPassedThroughUnconverted() = runTest {
        val document = text(spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0)))
        assertTrue(document.contains("TEXT 16,16,\"0\",0,12,12,\"ACME\""))
    }

    @Test
    fun quotesAreDoubled() = runTest {
        val document = text(spec(LabelElement.Text("t1", 2.0, 2.0, "Say \"hi\"", 10.0)))
        assertTrue(document.contains("\"Say \"\"hi\"\"\""))
    }

    @Test
    fun aBoxedTextWrapsAndAlignsEachLineItself() = runTest {
        val document = text(
            spec(LabelElement.Text("t1", 2.0, 2.0, "Hi", 12.0, maxWidthMm = 40.0, align = LabelAlign.CENTER)),
        )
        // The box is 320 dots, the estimate for two glyphs at twelve points is 37 dots, so the
        // offset is round((320 - 37) / 2) = 142 and x becomes 16 + 142.
        assertTrue(document.contains("TEXT 158,16,\"0\",0,12,12,\"Hi\""))
    }

    @Test
    fun anSsccBarcodeCarriesTheApplicationIdentifierAndBothBarWidths() = runTest {
        val document = text(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC), 15.0, 0.25)),
        )
        assertTrue(document.contains("BARCODE 32,96,\"128\",120,0,0,2,2,\"!100346006820000000014\""))
    }

    @Test
    fun aBarcodeWithoutAModuleWidthKeepsTheHistoricalTwoDotBar() = runTest {
        val document = text(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Literal("ABC"), 10.0)),
        )
        assertTrue(document.contains("BARCODE 32,96,\"128\",80,0,0,2,2,\"ABC\""))
    }

    @Test
    fun aBoxIsGivenAsOppositeCorners() = runTest {
        val document = text(spec(LabelElement.Box("x1", 1.0, 1.0, 10.0, 5.0, 0.25)))
        assertTrue(document.contains("BOX 8,8,88,48,2"))
    }

    @Test
    fun theImagePayloadIsRawInvertedBytes() = runTest {
        val bytes = generateTspl(
            spec(LabelElement.Field("f1", 5.0, 5.0, LabelField.PRODUCT_NAME, fontSizePt = 12.0)),
            data,
            stub,
        )
        val marker = "BITMAP 40,40,2,2,0,".toByteArray(Charsets.US_ASCII)
        val start = bytes.indexOfSlice(marker)
        assertTrue(start >= 0)
        val payloadAt = start + marker.size
        assertArrayEquals(
            byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()),
            bytes.copyOfRange(payloadAt, payloadAt + 4),
        )
    }

    @Test
    fun matrixAndEanFormatsAreRefusedByName() = runTest {
        for (format in listOf(BarcodeFormat.DATAMATRIX, BarcodeFormat.QR, BarcodeFormat.EAN13)) {
            val failure = runCatching {
                generateTspl(
                    spec(LabelElement.Barcode("b1", 2.0, 2.0, format, BarcodeSource.Literal("X"), 10.0)),
                    data,
                    null,
                )
            }.exceptionOrNull()
            assertTrue(format.wire, failure is LabelRenderException)
        }
    }
}

private fun ByteArray.indexOfSlice(slice: ByteArray): Int {
    outer@ for (start in 0..size - slice.size) {
        for (i in slice.indices) if (this[start + i] != slice[i]) continue@outer
        return start
    }
    return -1
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*TsplEmitterTest' -q
```

Expected: FAIL to compile, `Unresolved reference: generateTspl`.

- [ ] **Step 3: Write the emitter**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt`:

```kotlin
package app.markiro.handheld.core.label

import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** The historical narrow-bar width used when a template sets no module width. */
private const val DEFAULT_NARROW_DOTS = 2

/**
 * Port of `generateTspl` in packages/domain/src/labels/tspl.ts.
 *
 * Returns bytes rather than text because the image command's payload is raw binary. Encoding this
 * document as UTF-8 at any point would turn every payload byte above 0x7F into two bytes and destroy
 * the bitmap.
 *
 * The media gap and print direction are fixed here rather than carried on the template: they are a
 * property of the printer and its media, not of the label design.
 */
suspend fun generateTspl(
    spec: LabelSpec,
    data: Map<LabelField, String>,
    rasterize: RasterizeText?,
): ByteArray {
    val out = ByteArrayOutputStream()
    fun line(text: String) {
        out.write(text.toByteArray(Charsets.ISO_8859_1))
        out.write('\n'.code)
    }
    line("SIZE ${number(spec.widthMm)} mm, ${number(spec.heightMm)} mm")
    line("GAP 2 mm, 0 mm")
    line("DIRECTION 1")
    line("CLS")
    for (element in spec.elements) {
        when (element) {
            is LabelElement.Text -> textLike(
                spec, element.xMm, element.yMm, element.text, element.fontSizePt, element.bold,
                element.align, element.maxWidthMm, element.maxLines, rasterize, out, ::line,
            )
            is LabelElement.Field -> textLike(
                spec, element.xMm, element.yMm,
                labelFieldDisplayValue(element.field, data, element.textFormat),
                element.fontSizePt, element.bold, element.align, element.maxWidthMm, element.maxLines,
                rasterize, out, ::line,
            )
            is LabelElement.Barcode -> line(barcode(spec, element, data))
            is LabelElement.Line -> line(bar(spec, element))
            is LabelElement.Box -> line(box(spec, element))
        }
    }
    line("PRINT 1")
    return out.toByteArray()
}

/**
 * Renders a number the way the original does: a whole value carries no decimal point. Kotlin would
 * otherwise write `58.0` where the reference writes `58`, and the page size would differ.
 */
private fun number(value: Double): String =
    if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()

/** Doubling a quote is this language's only escape. Everything else, control bytes included, passes through. */
private fun escape(text: String): String = text.replace("\"", "\"\"")

private suspend fun textLike(
    spec: LabelSpec,
    xMm: Double,
    yMm: Double,
    text: String,
    fontSizePt: Double,
    bold: Boolean?,
    align: LabelAlign?,
    maxWidthMm: Double?,
    maxLines: Int?,
    rasterize: RasterizeText?,
    out: ByteArrayOutputStream,
    line: (String) -> Unit,
) {
    val x = mmToDots(xMm, spec.dpi)
    val y = mmToDots(yMm, spec.dpi)
    val maxWidthDots = maxWidthMm?.let { mmToDots(it, spec.dpi) }
    if (needsImageRendering(text)) {
        if (rasterize == null) {
            throw LabelRenderException(
                "label text \"$text\" contains characters outside printable ASCII and needs image rendering, " +
                    "but no rasterizer was provided",
            )
        }
        val raster = rasterize.rasterize(
            text,
            RasterOptions(
                fontFamily = "sans-serif",
                fontSizePx = ptToDots(fontSizePt, spec.dpi),
                bold = bold ?: false,
                maxWidthPx = maxWidthDots,
                maxLines = maxLines ?: 1,
            ),
        )
        val offset = rasterAlignOffsetDots(align, maxWidthDots, raster.width)
        buildBitmapCommand(x + offset, y, raster, out)
        out.write('\n'.code)
        return
    }
    // Wrapping returns null when the element carries no box or the text already fits, which keeps
    // output identical for templates written before wrapping existed.
    val wrapped = if (maxWidthMm == null) {
        null
    } else {
        wrapTextToWidth(text, { estimatedTextWidthMm(it, fontSizePt) }, maxWidthMm, maxLines ?: 1)
            .takeUnless { it.size == 1 && it[0] == text }
    }
    val lines = wrapped ?: listOf(text)
    val step = mmToDots(ptToMm(fontSizePt) * LINE_HEIGHT_EM, spec.dpi)
    lines.forEachIndexed { index, content ->
        // Alignment is measured with the same estimate used for wrapping, so the two never disagree.
        val offset = rasterAlignOffsetDots(align, maxWidthDots, mmToDots(estimatedTextWidthMm(content, fontSizePt), spec.dpi))
        // The font size goes into both scale slots unconverted: the internal scalable font reads
        // them as points, and `bold` has no native effect because that font carries no weight.
        line("TEXT ${x + offset},${y + index * step},\"0\",0,${number(fontSizePt)},${number(fontSizePt)},\"${escape(content)}\"")
    }
}

private fun barcode(spec: LabelSpec, element: LabelElement.Barcode, data: Map<LabelField, String>): String {
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val value = when (val source = element.data) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    val gs1 = element.data is BarcodeSource.Field && (element.data as BarcodeSource.Field).field == LabelField.SSCC
    // `!1` is this language's GS1 flag and `00` is the application identifier, added here and
    // nowhere else.
    val payload = if (gs1) "!100$value" else value
    val narrow = element.moduleWidthMm?.let { max(1, mmToDots(it, spec.dpi)) } ?: DEFAULT_NARROW_DOTS
    // The interpretation line is off, matching the other language.
    return "BARCODE $x,$y,\"128\",${mmToDots(element.sizeMm, spec.dpi)},0,0,$narrow,$narrow,\"${escape(payload)}\""
}

private fun bar(spec: LabelSpec, element: LabelElement.Line): String {
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    val spanX = mmToDots(abs(element.x2Mm - element.xMm), spec.dpi)
    val spanY = mmToDots(abs(element.y2Mm - element.yMm), spec.dpi)
    val originX = mmToDots(min(element.xMm, element.x2Mm), spec.dpi)
    val originY = mmToDots(min(element.yMm, element.y2Mm), spec.dpi)
    return "BAR $originX,$originY,${max(spanX, thickness)},${max(spanY, thickness)}"
}

private fun box(spec: LabelSpec, element: LabelElement.Box): String {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    // The end corner sums two separately rounded values. Rounding the sum instead can differ by a dot.
    val xEnd = x + mmToDots(element.widthMm, spec.dpi)
    val yEnd = y + mmToDots(element.heightMm, spec.dpi)
    return "BOX $x,$y,$xEnd,$yEnd,${mmToDots(element.thicknessMm, spec.dpi)}"
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*TsplEmitterTest' -q
```

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/TsplEmitterTest.kt
git commit -m "feat(handheld): TSPL emitter"
```

---

### Task 7: The fixture test that pins both emitters to the domain package

**Files:**

- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelFixturesTest.kt`

**Interfaces:**

- Consumes: `LabelSpecCodec.parse`, `generateZpl`, `generateTspl`, `RasterizeText`, and `label-fixtures.json` from Task 1.
- Produces: nothing. This is the gate that makes the port a port.

This task is separate from Tasks 5 and 6 because it is what a reviewer would reject or accept on its own: the emitters can look right and still disagree with the source.

- [ ] **Step 1: Write the test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelFixturesTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins both emitters to `packages/domain`. Text inside printable ASCII must match character for
 * character. Text outside it cannot: the image payload comes from Android's font engine, which is a
 * third implementation next to the browser canvas the station and the cabinet preview share, and
 * those two are deliberately pixel-identical to each other. Those cases assert the command framing
 * and the bitmap's dimensions and placement instead. A difference in glyph pixels is not a
 * regression here.
 */
class LabelFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:labels"
        }.readText(),
    ).jsonObject

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun data(o: JsonObject): Map<LabelField, String> =
        o.entries.associate { (key, value) -> LabelField.fromWire(key) to value.jsonPrimitive.content }

    /** Mirrors the stub in `packages/domain/src/labels/label-fixtures.ts` exactly. */
    private val stub = RasterizeText { text, options ->
        val natural = maxOf(1, text.codePointCount(0, text.length)) * Math.ceil(options.fontSizePx * 0.5).toInt()
        val width = options.maxWidthPx?.let { minOf(natural, it) } ?: natural
        val height = Math.ceil(options.fontSizePx * 1.5).toInt()
        val bytesPerRow = (width + 7) / 8
        val totalBytes = bytesPerRow * height
        RasterResult("A5".repeat(totalBytes), totalBytes, bytesPerRow, width, height)
    }

    @Test
    fun asciiSpecsRenderCharacterForCharacterInBothLanguages() = runTest {
        val cases = fixtures.getValue("byteIdentical").jsonArray
        assertTrue(cases.size >= 9)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val spec = LabelSpecCodec.spec(case.getValue("spec").jsonObject)
            val values = data(case.getValue("data").jsonObject)
            assertEquals(name, case.str("zpl"), generateZpl(spec, values, null))
            assertEquals(name, case.str("tspl"), String(generateTspl(spec, values, null), Charsets.ISO_8859_1))
        }
    }

    @Test
    fun cyrillicSpecsAskTheRasterizerForTheSameRunsAndFrameTheImageTheSameWay() = runTest {
        val cases = fixtures.getValue("structural").jsonArray
        assertTrue(cases.size >= 4)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val spec = LabelSpecCodec.spec(case.getValue("spec").jsonObject)
            val values = data(case.getValue("data").jsonObject)

            val calls = ArrayList<String>()
            val recording = RasterizeText { text, options ->
                calls += listOf(
                    text,
                    options.fontSizePx.toString(),
                    options.bold.toString(),
                    (options.maxWidthPx?.toString() ?: "null"),
                    options.maxLines.toString(),
                ).joinToString("|")
                stub.rasterize(text, options)
            }
            val zpl = generateZpl(spec, values, recording)

            val expectedCalls = case.getValue("rasterCalls").jsonArray.map { call ->
                val o = call.jsonObject
                listOf(
                    o.str("text"),
                    o.getValue("fontSizePx").jsonPrimitive.intOrNull.toString(),
                    (o.getValue("bold").jsonPrimitive.booleanOrNull == true).toString(),
                    (o.getValue("maxWidthPx").takeIf { it !is JsonNull }?.jsonPrimitive?.intOrNull?.toString() ?: "null"),
                    o.getValue("maxLines").jsonPrimitive.intOrNull.toString(),
                ).joinToString("|")
            }
            assertEquals(name, expectedCalls, calls)
            assertEquals(name, case.str("zplShape"), reduceZpl(zpl))

            val tspl = String(generateTspl(spec, values, stub), Charsets.ISO_8859_1)
            assertEquals(name, case.getValue("tsplShape").jsonArray.map { it.jsonPrimitive.content }, reduceTspl(tspl))
        }
    }

    private fun reduceZpl(document: String): String =
        Regex("\\^GFA,(\\d+),(\\d+),(\\d+),([0-9A-F]*)").replace(document) { m ->
            "^GFA,${m.groupValues[1]},${m.groupValues[2]},${m.groupValues[3]},<hex:${m.groupValues[4].length}>"
        }

    private fun reduceTspl(document: String): List<String> = document.split("\n").mapNotNull { line ->
        when {
            line.startsWith("BITMAP ") ->
                "BITMAP " + line.removePrefix("BITMAP ").split(",").take(5).joinToString(",") + ",<payload>"
            line.isEmpty() -> null
            else -> line
        }
    }
}
```

- [ ] **Step 2: Run it**

```bash
./gradlew testDebugUnitTest --tests '*LabelFixturesTest' -q
```

Expected: PASS. A failure here means the port and the TypeScript source disagree; fix the Kotlin, never the fixture. If the fixture genuinely needs to change, change `label-fixtures.ts` and regenerate, so both sides move together.

- [ ] **Step 3: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

```bash
git add apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelFixturesTest.kt
git commit -m "test(handheld): pin both label emitters to the domain fixtures"
```

---

### Task 8: The Android rasterizer, the render entry point and the test label

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/AndroidTextRasterizer.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelRenderer.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TestLabel.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelRendererTest.kt`

**Interfaces:**

- Consumes: `RasterizeText`, `RasterOptions`, `RasterResult`, `convertToMonochrome`, `bitmapToZplHex`, `wrapTextToWidth`, `clipWithEllipsis`, both emitters, `withPrinterDpi`.
- Produces: `AndroidTextRasterizer : RasterizeText`; `LabelRenderer.render(spec: LabelSpec, data: Map<LabelField, String>, language: PrinterLanguage, dpi: Int): ByteArray`; `TestLabel.spec()`, `TestLabel.data()`.

The rasterizer is the only file in `core/label` that touches Android. Everything else stays plain Kotlin so it runs in an ordinary unit test.

Reference for the drawing geometry: `apps/admin/src/labels/rasterizer.ts`. The line box is one and a half times the font size and the glyphs sit on the middle of that box. Reproducing this matters because the bitmap is anchored by its top-left corner while native text is anchored by its own top-left, so a rasterized run already sits slightly lower than a native one at the same coordinate. That offset is accepted in the original and must not be compensated here, or the handheld would disagree with the cabinet preview.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/LabelRendererTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Robolectric draws no real glyphs, so this asserts the contract around the bitmap: its dimensions,
 * the width clamp and the packing. Whether the letters look right is answered by printing the test
 * label on real hardware, which is what the manual verification step does.
 */
@RunWith(AndroidJUnit4::class)
class LabelRendererTest {
    private val rasterizer = AndroidTextRasterizer()

    @Test
    fun theBitmapNeverExceedsTheRequestedWidth() = runTest {
        val result = rasterizer.rasterize(
            "Очень длинное наименование товара",
            RasterOptions("sans-serif", fontSizePx = 34, bold = false, maxWidthPx = 120, maxLines = 2),
        )
        assertTrue(result.width <= 120)
        assertTrue(result.width >= 1)
        assertEquals((result.width + 7) / 8, result.bytesPerRow)
        assertEquals(result.bytesPerRow * result.height, result.totalBytes)
        assertEquals(result.totalBytes * 2, result.hex.length)
    }

    @Test
    fun theLineBoxIsOneAndAHalfTimesTheFontSize() = runTest {
        val one = rasterizer.rasterize("Вода", RasterOptions("sans-serif", 20, false, null, 1))
        assertEquals(30, one.height)
        val two = rasterizer.rasterize(
            "Вода питьевая негазированная",
            RasterOptions("sans-serif", 20, false, maxWidthPx = 40, maxLines = 2),
        )
        assertEquals(60, two.height)
    }

    @Test
    fun renderingPicksTheLanguageAndAppliesThePrinterResolution() = runTest {
        val spec = LabelSpec(58.0, 40.0, 203, PrinterLanguage.ZPL, listOf(LabelElement.Box("x1", 0.0, 0.0, 58.0, 40.0, 0.25)))
        val zpl = String(LabelRenderer(rasterizer).render(spec, emptyMap(), PrinterLanguage.ZPL, 300), Charsets.ISO_8859_1)
        assertTrue(zpl.startsWith("^XA\n^PW685\n^LL472\n"))
        val tspl = String(LabelRenderer(rasterizer).render(spec, emptyMap(), PrinterLanguage.TSPL, 203), Charsets.ISO_8859_1)
        assertTrue(tspl.startsWith("SIZE 58 mm, 40 mm\n"))
    }

    @Test
    fun theTestLabelRendersInBothLanguages() = runTest {
        val renderer = LabelRenderer(rasterizer)
        val spec = TestLabel.spec()
        for (language in PrinterLanguage.entries) {
            for (dpi in listOf(203, 300)) {
                val bytes = renderer.render(spec, TestLabel.data(), language, dpi)
                assertTrue("$language $dpi", bytes.size > 100)
            }
        }
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*LabelRendererTest' -q
```

Expected: FAIL to compile, `Unresolved reference: AndroidTextRasterizer`.

- [ ] **Step 3: Write the rasterizer**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/AndroidTextRasterizer.kt`:

```kotlin
package app.markiro.handheld.core.label

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Draws a text run with the platform's own font engine and hands the pixels to the shared packing
 * code. The only Android-dependent file in `core/label`.
 *
 * This output is not byte-comparable to the station's. The station and the cabinet editor share one
 * browser canvas implementation and are deliberately pixel-identical to each other so that preview
 * equals print; this is a third implementation. The same text lands at the same size in the same
 * place, and the glyph pixels differ. That is expected and is why the fixtures pin framing rather
 * than pixels.
 *
 * The line box and baseline mirror `apps/admin/src/labels/rasterizer.ts`: a box one and a half times
 * the font size, with the glyphs centred in it.
 */
@Singleton
class AndroidTextRasterizer @Inject constructor() : RasterizeText {
    override suspend fun rasterize(text: String, options: RasterOptions): RasterResult =
        withContext(Dispatchers.Default) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = options.fontSizePx.toFloat()
                typeface = Typeface.create(Typeface.SANS_SERIF, if (options.bold) Typeface.BOLD else Typeface.NORMAL)
                color = Color.BLACK
            }
            val measure: (String) -> Double = { paint.measureText(it).toDouble() }
            val maxWidth = options.maxWidthPx
            val lines = if (maxWidth == null) {
                listOf(text)
            } else {
                // The width limit is a contract, not a hint: a bitmap wider than its box prints off
                // the edge of the label.
                wrapTextToWidth(text, measure, maxWidth.toDouble(), options.maxLines)
                    .map { line -> if (measure(line) > maxWidth) clipWithEllipsis(line, measure, maxWidth.toDouble()) else line }
            }
            val natural = ceil(lines.maxOf { measure(it) }).toInt()
            val width = max(1, if (maxWidth == null) natural else min(natural, maxWidth))
            val lineHeight = ceil(options.fontSizePx * LINE_HEIGHT_EM).toInt()
            val height = max(1, lineHeight * lines.size)

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            // An opaque background matters: the monochrome step ignores alpha, so a transparent
            // pixel would be read as whatever colour sits underneath it.
            canvas.drawColor(Color.WHITE)
            val metrics = paint.fontMetrics
            lines.forEachIndexed { index, line ->
                val centre = index * lineHeight + lineHeight / 2f
                canvas.drawText(line, 0f, centre - (metrics.ascent + metrics.descent) / 2f, paint)
            }
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            bitmap.recycle()

            val packing = bitmapToZplHex(convertToMonochrome(pixels, width, height), width, height)
            RasterResult(packing.hex, packing.totalBytes, packing.bytesPerRow, width, height)
        }
}
```

- [ ] **Step 4: Write the render entry point**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/LabelRenderer.kt`:

```kotlin
package app.markiro.handheld.core.label

import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single call the rest of the app makes to turn a template into printer bytes. The printer's
 * language and resolution win over the template's own, which is what lets one template serve a belt
 * printer and a line printer at once.
 */
@Singleton
class LabelRenderer @Inject constructor(private val rasterize: RasterizeText) {
    suspend fun render(
        spec: LabelSpec,
        data: Map<LabelField, String>,
        language: PrinterLanguage,
        dpi: Int,
    ): ByteArray {
        val printSpec = withPrinterDpi(spec, dpi)
        return when (language) {
            PrinterLanguage.ZPL -> generateZpl(printSpec, data, rasterize).toByteArray(Charsets.ISO_8859_1)
            PrinterLanguage.TSPL -> generateTspl(printSpec, data, rasterize)
        }
    }
}
```

- [ ] **Step 5: Write the test label**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label/TestLabel.kt`:

```kotlin
package app.markiro.handheld.core.label

/**
 * The label the printer settings screen prints. Compiled in rather than fetched: the label-template
 * module is cabinet-only by design and a device credential cannot read it, and a handheld with no
 * shift joined has no template of its own.
 *
 * It deliberately carries the pair that can actually go wrong: a Cyrillic line, which takes the
 * image branch and exercises the platform's font engine, and an SSCC barcode, which stays a native
 * printer command. If both come out clean, the whole path works.
 */
object TestLabel {
    /** An eighteen-digit code that belongs to no real box; it exists to give the barcode a payload. */
    const val SAMPLE_SSCC = "046800899000000000"

    fun spec(): LabelSpec = LabelSpec(
        widthMm = 58.0,
        heightMm = 40.0,
        dpi = 203,
        language = PrinterLanguage.ZPL,
        elements = listOf(
            LabelElement.Box("frame", 1.0, 1.0, 56.0, 38.0, 0.25),
            LabelElement.Text("title", 4.0, 4.0, "Маркиро · тест печати", 10.0, bold = true),
            LabelElement.Text(
                "cyrillic", 4.0, 11.0,
                "Кириллица: Вода 0,5 л ПЭТ · Родник",
                8.0, maxWidthMm = 50.0, maxLines = 2,
            ),
            LabelElement.Line("rule", 4.0, 21.0, 54.0, 21.0, 0.25),
            LabelElement.Barcode(
                "bc", 6.0, 24.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC),
                sizeMm = 9.0, moduleWidthMm = 0.25,
            ),
            LabelElement.Field("hri", 4.0, 34.0, LabelField.SSCC, fontSizePt = 8.0, maxWidthMm = 50.0, align = LabelAlign.CENTER),
        ),
    )

    fun data(): Map<LabelField, String> = mapOf(LabelField.SSCC to SAMPLE_SSCC)
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*LabelRendererTest' -q
```

Expected: PASS.

- [ ] **Step 7: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/label apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label
git commit -m "feat(handheld): Android text rasterizer, render entry point and the test label"
```

---

### Task 9: Printer storage (Room v4)

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrinterEntities.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/StorageModule.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceWipe.kt`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/PrinterStorageTest.kt`

**Interfaces:**

- Consumes: nothing from earlier tasks. The language and resolution are stored as their wire forms so the table has no dependency on `core/label`.
- Produces: `PrinterEntity(id, name, transport, address, language, dpi, selected, lastStatus, lastSeenAt)`; `PrinterDao` with `observeAll()`, `all()`, `selected()`, `observeSelected()`, `upsert(printer)`, `select(id)`, `setStatus(id, status, at)`, `delete(id)`, `clear()`; `MIGRATION_3_4`.

- [ ] **Step 1: Write the failing storage test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/PrinterStorageTest.kt`:

```kotlin
package app.markiro.handheld.core.print

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun printer(id: String, selected: Boolean = false) = PrinterEntity(
        id = id, name = "Zebra $id", transport = "wifi", address = "192.168.1.40:9100",
        language = "zpl", dpi = 203, selected = selected, lastStatus = null, lastSeenAt = null,
    )

    @Test
    fun selectingOnePrinterDeselectsTheOthers() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.upsert(printer("b"))
        assertEquals("a", dao.selected()?.id)
        dao.select("b")
        assertEquals("b", dao.selected()?.id)
        assertEquals(listOf(false, true), dao.all().sortedBy { it.id }.map { it.selected })
    }

    @Test
    fun deletingTheSelectedPrinterLeavesNoneSelected() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.delete("a")
        assertNull(dao.selected())
        assertEquals(emptyList<PrinterEntity>(), dao.observeAll().first())
    }

    @Test
    fun statusIsRecordedWithItsTimestamp() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.setStatus("a", "ready", 1_757_000_000_000L)
        assertEquals("ready", dao.selected()?.lastStatus)
        assertEquals(1_757_000_000_000L, dao.selected()?.lastSeenAt)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*PrinterStorageTest' -q
```

Expected: FAIL to compile, `Unresolved reference: PrinterEntity`.

- [ ] **Step 3: Create the entity and DAO**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrinterEntities.kt`:

```kotlin
package app.markiro.handheld.core.print

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * A printer this handheld can send to. Device-local by the same rule the station states in
 * `apps/station/src/lib/hardware-config.ts`: held on the device, not the server, so it configures
 * and runs offline. Language and resolution are per printer, because a plant can run a belt printer
 * and a line printer side by side.
 */
@Entity(tableName = "printers")
data class PrinterEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** `wifi` or `bluetooth`. */
    val transport: String,
    /** `host:port` for Wi-Fi, the device address for Bluetooth. */
    val address: String,
    /** `zpl` or `tspl`. */
    val language: String,
    /** 203 or 300. */
    val dpi: Int,
    val selected: Boolean,
    /** What the printer last reported, for the list subtitle. */
    val lastStatus: String?,
    val lastSeenAt: Long?,
)

@Dao
interface PrinterDao {
    @Query("SELECT * FROM printers ORDER BY name")
    fun observeAll(): Flow<List<PrinterEntity>>

    @Query("SELECT * FROM printers ORDER BY name")
    suspend fun all(): List<PrinterEntity>

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    suspend fun selected(): PrinterEntity?

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    fun observeSelected(): Flow<PrinterEntity?>

    @Upsert
    suspend fun upsert(printer: PrinterEntity)

    /** One statement, so exactly one row is selected and the rest are cleared together. */
    @Query("UPDATE printers SET selected = (id = :id)")
    suspend fun select(id: String)

    @Query("UPDATE printers SET lastStatus = :status, lastSeenAt = :at WHERE id = :id")
    suspend fun setStatus(id: String, status: String?, at: Long)

    @Query("DELETE FROM printers WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM printers")
    suspend fun clear()
}
```

- [ ] **Step 4: Register the entity, the DAO and the migration**

In `core/storage/HandheldDatabase.kt`: add imports for `app.markiro.handheld.core.print.PrinterDao` and `app.markiro.handheld.core.print.PrinterEntity`, add `PrinterEntity::class` to the `entities` array, change `version = 3` to `version = 4`, and add the accessor `abstract fun printerDao(): PrinterDao`.

Append to `core/storage/Migrations.kt`:

```kotlin
/** Version 3 (inventory check) → 4 (printing). Additive only; printers are new and nothing else moves. */
val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `printers` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `transport` TEXT NOT NULL, " +
                "`address` TEXT NOT NULL, `language` TEXT NOT NULL, `dpi` INTEGER NOT NULL, `selected` INTEGER NOT NULL, " +
                "`lastStatus` TEXT, `lastSeenAt` INTEGER, PRIMARY KEY(`id`))",
        )
    }
}
```

In `core/storage/StorageModule.kt` change the migration list to `.addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)` and add, with the matching import:

```kotlin
    @Provides
    fun printerDao(db: HandheldDatabase): PrinterDao = db.printerDao()
```

In `core/storage/DeviceWipe.kt` add `db.printerDao().clear()` as the first call inside `db.withTransaction { ... }`, so an unbound device forgets its printers too.

- [ ] **Step 5: Extend the migration test**

In `MigrationTest.kt` add `MIGRATION_3_4` to `.addMigrations(...)`, update the doc comment to name it, add the import `app.markiro.handheld.core.print.PrinterEntity`, and add inside the `try` block after the inventory-outbox assertion:

```kotlin
            db.printerDao().upsert(
                PrinterEntity(
                    id = "p1", name = "Zebra ZD421", transport = "wifi", address = "192.168.1.40:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
            assertEquals("p1", db.printerDao().selected()?.id)
```

- [ ] **Step 6: Run both tests, then the gate**

```bash
./gradlew testDebugUnitTest --tests '*PrinterStorageTest' --tests '*MigrationTest' -q
```

Expected: PASS.

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core apps/handheld/app/src/test/kotlin/app/markiro/handheld/core
git commit -m "feat(handheld): printer table on Room v4"
```

---

### Task 10: The transport contract and the Wi-Fi connector

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrinterTransport.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/WifiPrinterConnector.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/PrinterTransportTest.kt`

**Interfaces:**

- Consumes: `PrinterEntity` from Task 9.
- Produces: `PrinterConnection`, `PrinterConnector`, `PrinterStatus`, `NotReadyReason`, `SendOutcome`, `PrinterTransport` (the interface a screen depends on), `StreamPrinterTransport` (its socket implementation), `WifiPrinterConnector`, `PRINTER_TIMEOUT_MS`.

The outcome semantics live in one place, `StreamPrinterTransport`, and each transport only knows how to open a stream. That is what lets the Wi-Fi path be tested against a real socket while the Bluetooth path, which no emulator can exercise, reuses the identical logic.

The three outcomes are not interchangeable. Refused means nothing was printed and we know it. Unknown means the bytes may or may not have arrived, and it is the one case a machine must not resolve on its own: an automatic retry there could put a second label on a box the server has already accepted.

- [ ] **Step 1: Write the failing test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/PrinterTransportTest.kt`:

```kotlin
package app.markiro.handheld.core.print

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket

class PrinterTransportTest {
    private fun printer(address: String, language: String = "zpl") = PrinterEntity(
        id = "p1", name = "Test", transport = "wifi", address = address,
        language = language, dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
    )

    private class FakeConnection(reply: ByteArray, private val failAfter: Int?) : PrinterConnection {
        val written = ByteArrayOutputStream()
        override val input: InputStream = ByteArrayInputStream(reply)
        override val output: OutputStream = object : OutputStream() {
            private var count = 0
            override fun write(b: Int) {
                if (failAfter != null && count >= failAfter) throw IOException("link dropped")
                count++
                written.write(b)
            }
        }
        override fun close() = Unit
    }

    private fun transport(connector: PrinterConnector) = StreamPrinterTransport { connector }

    @Test
    fun aReadyPrinterAcceptsTheDocument() = runTest {
        val connection = FakeConnection(byteArrayOf(), null)
        val outcome = transport { connection }.send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertEquals(SendOutcome.Delivered, outcome)
        assertEquals("^XA^XZ", connection.written.toString("US-ASCII"))
    }

    @Test
    fun aLinkThatBreaksPartwayThroughIsUnknownNotRefused() = runTest {
        val connection = FakeConnection(byteArrayOf(), failAfter = 3)
        val outcome = transport { connection }.send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Unknown)
    }

    @Test
    fun aConnectionThatNeverOpensIsRefused() = runTest {
        val outcome = transport { throw IOException("no route to host") }
            .send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Refused)
        assertEquals(NotReadyReason.UNREACHABLE, (outcome as SendOutcome.Refused).reason)
    }

    @Test
    fun theZplStatusReplyIsDecoded() = runTest {
        val ready = "PRINTER STATUS\r\n ERRORS: 0 00000000 00000000\r\n".toByteArray()
        assertEquals(PrinterStatus.Ready, transport { FakeConnection(ready, null) }.status(printer("host:9100")))
        val noPaper = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000001\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            transport { FakeConnection(noPaper, null) }.status(printer("host:9100")),
        )
        val headOpen = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000004\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN),
            transport { FakeConnection(headOpen, null) }.status(printer("host:9100")),
        )
        val other = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000040\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.OTHER),
            transport { FakeConnection(other, null) }.status(printer("host:9100")),
        )
    }

    @Test
    fun theTsplStatusReplyIsDecoded() = runTest {
        val cases = mapOf(
            0x00 to PrinterStatus.Ready,
            0x01 to PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN),
            0x04 to PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            0x05 to PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            0x80 to PrinterStatus.NotReady(NotReadyReason.OTHER),
        )
        for ((byte, expected) in cases) {
            val connection = FakeConnection(byteArrayOf(byte.toByte()), null)
            assertEquals(byte.toString(), expected, transport { connection }.status(printer("host:9100", "tspl")))
        }
    }

    @Test
    fun aSilentPrinterIsNotReady() = runTest {
        val outcome = transport { FakeConnection(byteArrayOf(), null) }.status(printer("host:9100"))
        assertEquals(PrinterStatus.NotReady(NotReadyReason.UNREACHABLE), outcome)
    }

    @Test
    fun theWifiConnectorReachesARealSocket() = runTest {
        val server = withContext(Dispatchers.IO) { ServerSocket(0) }
        val received = ByteArrayOutputStream()
        val accepting = launch(Dispatchers.IO) {
            server.accept().use { socket ->
                socket.getInputStream().copyTo(received)
            }
        }
        val transport = StreamPrinterTransport { WifiPrinterConnector() }
        val outcome = transport.send(printer("127.0.0.1:${server.localPort}"), "^XA^XZ".toByteArray())
        accepting.join()
        withContext(Dispatchers.IO) { server.close() }
        assertEquals(SendOutcome.Delivered, outcome)
        assertEquals("^XA^XZ", received.toString("US-ASCII"))
    }

    @Test
    fun aClosedPortIsRefused() = runTest {
        val port = withContext(Dispatchers.IO) { ServerSocket(0).use { it.localPort } }
        val transport = StreamPrinterTransport { WifiPrinterConnector() }
        val outcome = transport.send(printer("127.0.0.1:$port"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Refused)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*PrinterTransportTest' -q
```

Expected: FAIL to compile, `Unresolved reference: PrinterConnection`.

- [ ] **Step 3: Write the contract and the outcome logic**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrinterTransport.kt`:

```kotlin
package app.markiro.handheld.core.print

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** The drawn timeout: a printer that has not answered in five seconds is not answering. */
const val PRINTER_TIMEOUT_MS = 5_000

enum class NotReadyReason { NO_PAPER, HEAD_OPEN, UNREACHABLE, OTHER }

sealed interface PrinterStatus {
    data object Ready : PrinterStatus
    data class NotReady(val reason: NotReadyReason) : PrinterStatus
}

/**
 * What became of a document.
 *
 * `Refused` and `Unknown` are deliberately different. Refused means nothing was printed and we know
 * it. Unknown means the bytes may or may not have arrived, and nothing may resend on its own from
 * there: an automatic retry could put a second label on a box the server has already accepted. Only
 * a person who has looked at the printer resolves an unknown.
 */
sealed interface SendOutcome {
    data object Delivered : SendOutcome
    data class Refused(val reason: NotReadyReason) : SendOutcome
    data class Unknown(val cause: String) : SendOutcome
}

interface PrinterConnection : Closeable {
    val input: InputStream
    val output: OutputStream
}

fun interface PrinterConnector {
    /** Opens a connection, or throws `IOException` when the printer cannot be reached at all. */
    suspend fun open(printer: PrinterEntity): PrinterConnection
}

/** What a screen needs from a printer. Separated from the socket work so a view model can be tested. */
interface PrinterTransport {
    suspend fun status(printer: PrinterEntity): PrinterStatus
    suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome
}

/**
 * Status and send over any byte stream. Neither printer language acknowledges a print job, so
 * `Delivered` means the bytes left this device, not that paper moved. That is exactly why the status
 * query runs first and why the operator confirms afterwards.
 */
class StreamPrinterTransport(private val connectors: (PrinterEntity) -> PrinterConnector) : PrinterTransport {

    override suspend fun status(printer: PrinterEntity): PrinterStatus = withContext(Dispatchers.IO) {
        val query = if (printer.language == "tspl") TSPL_STATUS_QUERY else ZPL_STATUS_QUERY
        val reply = try {
            connectors(printer).open(printer).use { connection ->
                connection.output.write(query)
                connection.output.flush()
                connection.input.readBytes()
            }
        } catch (_: IOException) {
            return@withContext PrinterStatus.NotReady(NotReadyReason.UNREACHABLE)
        }
        if (reply.isEmpty()) return@withContext PrinterStatus.NotReady(NotReadyReason.UNREACHABLE)
        if (printer.language == "tspl") decodeTsplStatus(reply) else decodeZplStatus(reply)
    }

    override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome = withContext(Dispatchers.IO) {
        val connection = try {
            connectors(printer).open(printer)
        } catch (_: IOException) {
            return@withContext SendOutcome.Refused(NotReadyReason.UNREACHABLE)
        }
        try {
            connection.use {
                it.output.write(document)
                it.output.flush()
            }
            SendOutcome.Delivered
        } catch (e: IOException) {
            // The connection was open, so some or all of the document may already be on the printer.
            SendOutcome.Unknown(e.message ?: "link lost")
        }
    }
}

/** Host status query. The reply's error line carries a flag and two masks. */
private val ZPL_STATUS_QUERY = "~HQES".toByteArray(Charsets.US_ASCII)

/** Escape, bang, question mark: the reply is a single status byte. */
private val TSPL_STATUS_QUERY = byteArrayOf(0x1B, 0x21, 0x3F)

private val ERRORS_LINE = Regex("ERRORS:\\s*(\\d)\\s+[0-9A-Fa-f]+\\s+([0-9A-Fa-f]+)")

/**
 * Decodes the host status reply. Only the two conditions the printer screen names are mapped by
 * name; anything else the printer flags becomes a generic refusal rather than a guess. The exact
 * flag bits are the part of this file most likely to need adjusting against real hardware.
 */
internal fun decodeZplStatus(reply: ByteArray): PrinterStatus {
    val match = ERRORS_LINE.find(String(reply, Charsets.US_ASCII))
        ?: return PrinterStatus.NotReady(NotReadyReason.OTHER)
    if (match.groupValues[1] == "0") return PrinterStatus.Ready
    val mask = match.groupValues[2].toLongOrNull(16) ?: return PrinterStatus.NotReady(NotReadyReason.OTHER)
    return when {
        mask and 0x1L != 0L -> PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        mask and 0x4L != 0L -> PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN)
        else -> PrinterStatus.NotReady(NotReadyReason.OTHER)
    }
}

/** The single status byte: zero is normal, and the low bits flag the two conditions we name. */
internal fun decodeTsplStatus(reply: ByteArray): PrinterStatus {
    val value = reply.first().toInt() and 0xFF
    return when {
        value == 0 -> PrinterStatus.Ready
        value and 0x04 != 0 -> PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        value and 0x01 != 0 -> PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN)
        else -> PrinterStatus.NotReady(NotReadyReason.OTHER)
    }
}
```

- [ ] **Step 4: Write the Wi-Fi connector**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/WifiPrinterConnector.kt`:

```kotlin
package app.markiro.handheld.core.print

import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.inject.Inject

/** A printer standing at the line, reached over the network on its raw printing port. */
class WifiPrinterConnector @Inject constructor() : PrinterConnector {
    override suspend fun open(printer: PrinterEntity): PrinterConnection {
        val (host, port) = parseAddress(printer.address)
        val socket = Socket()
        socket.soTimeout = PRINTER_TIMEOUT_MS
        socket.connect(InetSocketAddress(host, port), PRINTER_TIMEOUT_MS)
        return object : PrinterConnection {
            override val input: InputStream = socket.getInputStream()
            override val output: OutputStream = socket.getOutputStream()
            override fun close() = socket.close()
        }
    }

    companion object {
        const val DEFAULT_PORT = 9100

        /** `host:port`, with the raw printing port assumed when none is given. */
        fun parseAddress(address: String): Pair<String, Int> {
            val separator = address.lastIndexOf(':')
            if (separator <= 0) return address to DEFAULT_PORT
            val port = address.substring(separator + 1).toIntOrNull() ?: return address to DEFAULT_PORT
            return address.substring(0, separator) to port
        }
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*PrinterTransportTest' -q
```

Expected: PASS, including the two cases that use a real socket.

- [ ] **Step 6: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print
git commit -m "feat(handheld): printer transport contract and the Wi-Fi connector"
```

---

### Task 11: The Bluetooth connector, discovery and permissions

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/BluetoothPrinterConnector.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrintModule.kt`
- Modify: `apps/handheld/app/src/main/AndroidManifest.xml`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/BluetoothPermissionsTest.kt`

**Interfaces:**

- Consumes: `PrinterConnector`, `PrinterConnection`, `StreamPrinterTransport` from Task 10; `PrinterDao` from Task 9; `LabelRenderer` and `AndroidTextRasterizer` from Task 8.
- Produces: `BluetoothPrinterConnector` with `pairedPrinters(): List<DiscoveredPrinter>` and `open(printer)`; `DiscoveredPrinter(address, name, bonded)`; `bluetoothPermissions(): Array<String>`; Hilt bindings for `PrinterTransport`, `RasterizeText` and `LabelRenderer`.

An emulator has no Bluetooth radio, so this connector cannot be exercised there. That is why the outcome logic lives in the shared transport from Task 10 and why the pull request must report Bluetooth as untested on hardware rather than implying coverage.

The permission set differs by platform version and the difference is not cosmetic: asking for the wrong one on the wrong version silently returns an empty device list.

- [ ] **Step 1: Write the failing permissions test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print/BluetoothPermissionsTest.kt`:

```kotlin
package app.markiro.handheld.core.print

import android.Manifest
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class BluetoothPermissionsTest {
    @Test
    @Config(sdk = [28])
    fun olderPlatformsAskForLocationBecauseDiscoveryNeedsIt() {
        assertArrayEquals(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), bluetoothPermissions())
    }

    @Test
    @Config(sdk = [33])
    fun currentPlatformsAskForTheBluetoothPair() {
        assertArrayEquals(
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT),
            bluetoothPermissions(),
        )
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*BluetoothPermissionsTest' -q
```

Expected: FAIL to compile, `Unresolved reference: bluetoothPermissions`.

- [ ] **Step 3: Declare the permissions**

In `apps/handheld/app/src/main/AndroidManifest.xml`, after the existing `uses-permission` lines:

```xml
    <!-- Before Android 12 a Bluetooth scan was a location capability, so discovery needed it. -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <!-- From Android 12 the two Bluetooth permissions are their own; this app never infers location. -->
    <uses-permission
        android:name="android.permission.BLUETOOTH_SCAN"
        android:usesPermissionFlags="neverForLocation"
        tools:targetApi="s" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

The `tools:` prefix needs `xmlns:tools="http://schemas.android.com/tools"` on the `<manifest>` element; add it if it is not already there.

- [ ] **Step 4: Write the connector**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/BluetoothPrinterConnector.kt`:

```kotlin
package app.markiro.handheld.core.print

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import javax.inject.Inject

/** A printer offered by the platform, either already paired or newly found. */
data class DiscoveredPrinter(val address: String, val name: String, val bonded: Boolean)

/**
 * The permissions Bluetooth needs on this platform version. Asking for the wrong set does not fail
 * loudly: the device list simply comes back empty.
 */
fun bluetoothPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

/**
 * A printer worn on the belt, reached over the serial port profile.
 *
 * No emulator has a Bluetooth radio, so this class is verified on hardware only. Everything that
 * decides what an outcome means lives in `StreamPrinterTransport` instead, where it is tested.
 */
class BluetoothPrinterConnector @Inject constructor(
    @ApplicationContext private val context: Context,
) : PrinterConnector {

    private val adapter: BluetoothAdapter?
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter

    /** Devices the platform already knows. Pairing itself happens in the system dialog. */
    @SuppressLint("MissingPermission")
    fun pairedPrinters(): List<DiscoveredPrinter> =
        adapter?.bondedDevices.orEmpty().map { device ->
            DiscoveredPrinter(device.address, device.name ?: device.address, bonded = true)
        }

    @SuppressLint("MissingPermission")
    override suspend fun open(printer: PrinterEntity): PrinterConnection {
        val adapter = adapter ?: throw IOException("bluetooth unavailable")
        val device = adapter.getRemoteDevice(printer.address)
        val socket = device.createRfcommSocketToServiceRecord(SPP)
        // Discovery keeps the radio busy and makes a connection attempt fail slowly.
        adapter.cancelDiscovery()
        socket.connect()
        return object : PrinterConnection {
            override val input: InputStream = socket.inputStream
            override val output: OutputStream = socket.outputStream
            override fun close() = socket.close()
        }
    }

    private companion object {
        /** The serial port profile, which is what label printers expose. */
        val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
```

- [ ] **Step 5: Wire the module**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print/PrintModule.kt`:

```kotlin
package app.markiro.handheld.core.print

import app.markiro.handheld.core.label.AndroidTextRasterizer
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterizeText
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PrintModule {
    @Provides
    @Singleton
    fun rasterizeText(rasterizer: AndroidTextRasterizer): RasterizeText = rasterizer

    @Provides
    @Singleton
    fun labelRenderer(rasterize: RasterizeText): LabelRenderer = LabelRenderer(rasterize)

    @Provides
    @Singleton
    fun printerTransport(
        wifi: WifiPrinterConnector,
        bluetooth: BluetoothPrinterConnector,
    ): PrinterTransport = StreamPrinterTransport { printer ->
        if (printer.transport == "bluetooth") bluetooth else wifi
    }
}
```

- [ ] **Step 6: Run the test, then the gate**

```bash
./gradlew testDebugUnitTest --tests '*BluetoothPermissionsTest' -q
```

Expected: PASS.

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors. If lint reports a missing permission check on the Bluetooth calls, confirm the `@SuppressLint("MissingPermission")` annotations are present; the screen asks for the permission before it ever calls these.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/print apps/handheld/app/src/main/AndroidManifest.xml apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/print
git commit -m "feat(handheld): Bluetooth printer connector, permissions and print module"
```

---

### Task 12: The printer view model and its strings

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/PrinterViewModel.kt`
- Modify: `apps/handheld/app/src/main/res/values/strings.xml`
- Modify: `apps/handheld/app/src/main/res/values-en/strings.xml`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/printer/PrinterViewModelTest.kt`

**Interfaces:**

- Consumes: `PrinterDao`, `PrinterEntity` (Task 9); `PrinterTransport`, `PrinterStatus`, `NotReadyReason`, `SendOutcome` (Task 10); `DiscoveredPrinter`, `BluetoothPrinterConnector` (Task 11); `LabelRenderer`, `TestLabel`, `PrinterLanguage` (Tasks 2 and 8).
- Produces: `PrinterUi`, `AddPrinterForm`, `TestPrintStep`, `PrinterViewModel` with `state`, `addForm`, `testStep`, and the methods `select(id)`, `remove(id)`, `startAdd(transport)`, `editHost(value)`, `editPort(value)`, `setLanguage(language)`, `setDpi(dpi)`, `checkAndSave()`, `loadPairedDevices()`, `pickPairedDevice(device)`, `printTest()`, `confirmTestPrinted()`, `retryTest()`, `dismissTest()`.

- [ ] **Step 1: Add the strings**

Append to `apps/handheld/app/src/main/res/values/strings.xml`, before the closing tag:

```xml
    <string name="printer_title">Принтер</string>
    <string name="printer_selected">ВЫБРАН</string>
    <string name="printer_available">ДОСТУПНЫЕ</string>
    <string name="printer_none">принтер не настроен</string>
    <string name="printer_language_and_dpi">Язык и плотность</string>
    <string name="printer_language_dpi_value">%1$s · %2$d dpi</string>
    <string name="printer_test">Тестовая печать</string>
    <string name="printer_add_by_address">Добавить по адресу</string>
    <string name="printer_add_title">Добавить принтер</string>
    <string name="printer_transport_wifi">По сети (Wi-Fi)</string>
    <string name="printer_transport_wifi_hint">принтер у линии · адрес и порт 9100</string>
    <string name="printer_transport_bluetooth">Bluetooth</string>
    <string name="printer_transport_bluetooth_hint">мобильный принтер на поясе</string>
    <string name="printer_host">IP-адрес</string>
    <string name="printer_port">Порт</string>
    <string name="printer_language">Язык принтера</string>
    <string name="printer_dpi">Плотность</string>
    <string name="printer_check">Проверить связь</string>
    <string name="printer_check_again">Проверить снова</string>
    <string name="printer_edit_address">Изменить адрес</string>
    <string name="printer_unreachable_title">Принтер не отвечает</string>
    <string name="printer_unreachable_body">%1$s · нет ответа %2$d с. Проверьте, что принтер включён, в той же сети Wi-Fi, и адрес указан верно.</string>
    <string name="printer_no_paper">Нет бумаги</string>
    <string name="printer_head_open">Открыта крышка</string>
    <string name="printer_not_ready">Принтер не готов</string>
    <string name="printer_bluetooth_title">Bluetooth-принтер</string>
    <string name="printer_bluetooth_hint">Включите принтер и Bluetooth на нём. Сопряжённые принтеры появятся в списке.</string>
    <string name="printer_bluetooth_found">НАЙДЕНЫ</string>
    <string name="printer_bluetooth_search_again">Искать снова</string>
    <string name="printer_bluetooth_pick">Выбрать</string>
    <string name="printer_bluetooth_permission">Нужен доступ к Bluetooth, чтобы увидеть принтеры.</string>
    <string name="printer_bluetooth_grant">Разрешить</string>
    <string name="printer_bluetooth_empty">Сопряжённых принтеров нет. Сопрягите принтер в настройках Android и вернитесь сюда.</string>
    <string name="printer_test_title">Тестовая печать</string>
    <string name="printer_test_sending">Отправляем этикетку…</string>
    <string name="printer_test_sent">Тестовая этикетка отправлена</string>
    <string name="printer_test_question">Этикетка напечаталась чётко, кириллица и штрих-код читаются?</string>
    <string name="printer_test_yes">Да, всё чётко</string>
    <string name="printer_test_no">Нет, повторить</string>
    <string name="printer_test_unknown_title">Результат печати неизвестен</string>
    <string name="printer_test_unknown_body">Посмотрите на принтер. Если этикетка вышла — подтвердите. Повтор без подтверждения не отправляется.</string>
    <string name="printer_test_unknown_confirm">Этикетка напечаталась</string>
    <string name="printer_test_unknown_again">Напечатать ещё раз</string>
    <string name="printer_test_failed">Этикетка не напечатана</string>
    <string name="printer_remove">Удалить принтер</string>
```

Append the mirror to `apps/handheld/app/src/main/res/values-en/strings.xml`:

```xml
    <string name="printer_title">Printer</string>
    <string name="printer_selected">SELECTED</string>
    <string name="printer_available">AVAILABLE</string>
    <string name="printer_none">printer not configured</string>
    <string name="printer_language_and_dpi">Language and density</string>
    <string name="printer_language_dpi_value">%1$s · %2$d dpi</string>
    <string name="printer_test">Test print</string>
    <string name="printer_add_by_address">Add by address</string>
    <string name="printer_add_title">Add a printer</string>
    <string name="printer_transport_wifi">Over the network (Wi-Fi)</string>
    <string name="printer_transport_wifi_hint">a printer at the line · address and port 9100</string>
    <string name="printer_transport_bluetooth">Bluetooth</string>
    <string name="printer_transport_bluetooth_hint">a mobile printer on the belt</string>
    <string name="printer_host">IP address</string>
    <string name="printer_port">Port</string>
    <string name="printer_language">Printer language</string>
    <string name="printer_dpi">Density</string>
    <string name="printer_check">Check the connection</string>
    <string name="printer_check_again">Check again</string>
    <string name="printer_edit_address">Edit the address</string>
    <string name="printer_unreachable_title">The printer is not responding</string>
    <string name="printer_unreachable_body">%1$s · no answer in %2$d s. Check that the printer is on, on the same Wi-Fi network, and that the address is right.</string>
    <string name="printer_no_paper">Out of paper</string>
    <string name="printer_head_open">The head is open</string>
    <string name="printer_not_ready">The printer is not ready</string>
    <string name="printer_bluetooth_title">Bluetooth printer</string>
    <string name="printer_bluetooth_hint">Turn the printer on and enable Bluetooth on it. Paired printers appear in the list.</string>
    <string name="printer_bluetooth_found">FOUND</string>
    <string name="printer_bluetooth_search_again">Search again</string>
    <string name="printer_bluetooth_pick">Pick</string>
    <string name="printer_bluetooth_permission">Bluetooth access is needed to see the printers.</string>
    <string name="printer_bluetooth_grant">Allow</string>
    <string name="printer_bluetooth_empty">No paired printers. Pair the printer in the Android settings and come back.</string>
    <string name="printer_test_title">Test print</string>
    <string name="printer_test_sending">Sending the label…</string>
    <string name="printer_test_sent">The test label was sent</string>
    <string name="printer_test_question">Did the label come out clean, with the Cyrillic line and the barcode readable?</string>
    <string name="printer_test_yes">Yes, all clean</string>
    <string name="printer_test_no">No, print again</string>
    <string name="printer_test_unknown_title">The print result is unknown</string>
    <string name="printer_test_unknown_body">Look at the printer. If the label came out, confirm it. Nothing is resent without a confirmation.</string>
    <string name="printer_test_unknown_confirm">The label was printed</string>
    <string name="printer_test_unknown_again">Print it again</string>
    <string name="printer_test_failed">The label was not printed</string>
    <string name="printer_remove">Remove the printer</string>
```

- [ ] **Step 2: Write the failing view model test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/printer/PrinterViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.printer

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase

    /** `nextStatus` rather than `status`, so the property never shadows the method it stands in for. */
    private class FakeTransport(
        var nextStatus: PrinterStatus = PrinterStatus.Ready,
        var outcome: SendOutcome = SendOutcome.Delivered,
    ) : PrinterTransport {
        var sent = 0
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent++
            return outcome
        }
    }

    private val rasterize = RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun vm(
        transport: FakeTransport = FakeTransport(),
        paired: List<DiscoveredPrinter> = emptyList(),
    ) = PrinterViewModel(db.printerDao(), transport, LabelRenderer(rasterize), { paired }, { 1_757_000_000_000L })

    @Test
    fun aCheckedPrinterIsSavedAndSelected() = runTest {
        val transport = FakeTransport()
        val model = vm(transport)
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.editPort("9100")
        model.setDpi(300)
        model.checkAndSave()
        advanceUntilIdle()
        val saved = model.state.first { it.printers.isNotEmpty() }
        assertEquals("192.168.1.40:9100", saved.selected?.address)
        assertEquals(300, saved.selected?.dpi)
        assertEquals("ready", saved.selected?.lastStatus)
    }

    @Test
    fun aPrinterThatIsNotReadySurfacesItsOwnReasonAndIsNotSaved() = runTest {
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        val model = vm(transport)
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        advanceUntilIdle()
        assertEquals(NotReadyReason.NO_PAPER, model.addForm.first { it.error != null }.error)
        assertEquals(emptyList<PrinterEntity>(), db.printerDao().all())
    }

    @Test
    fun aDeliveredTestPrintAsksTheOperatorToConfirmIt() = runTest {
        val transport = FakeTransport()
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        assertTrue(model.testStep.first { it is TestPrintStep.Sent } is TestPrintStep.Sent)
        assertEquals(1, transport.sent)
    }

    @Test
    fun anUnknownResultNeverResendsOnItsOwn() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        assertTrue(model.testStep.first { it is TestPrintStep.Unknown } is TestPrintStep.Unknown)
        assertEquals(1, transport.sent)
        // Confirming resolves it without sending anything more.
        model.confirmTestPrinted()
        advanceUntilIdle()
        assertEquals(1, transport.sent)
        assertTrue(model.testStep.value is TestPrintStep.Idle)
    }

    @Test
    fun retryingAnUnknownResultIsAnExplicitSecondSend() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        model.retryTest()
        advanceUntilIdle()
        assertEquals(2, transport.sent)
    }

    @Test
    fun aRefusedPrintNamesTheReason() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Refused(NotReadyReason.NO_PAPER))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        val step = model.testStep.first { it is TestPrintStep.Failed } as TestPrintStep.Failed
        assertEquals(NotReadyReason.NO_PAPER, step.reason)
    }

    @Test
    fun aPrinterOutOfPaperIsCaughtBeforeAnythingIsSent() = runTest {
        val transport = FakeTransport()
        val model = vm(transport)
        saveSelected(model)
        transport.nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        model.printTest()
        advanceUntilIdle()
        val step = model.testStep.first { it is TestPrintStep.Failed } as TestPrintStep.Failed
        assertEquals(NotReadyReason.NO_PAPER, step.reason)
        assertEquals(0, transport.sent)
    }

    @Test
    fun pairedBluetoothDevicesAreOffered() = runTest {
        val model = vm(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true)))
        model.loadPairedDevices()
        advanceUntilIdle()
        assertEquals(listOf("Zebra ZQ320"), model.state.first { it.paired.isNotEmpty() }.paired.map { it.name })
        model.pickPairedDevice(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true))
        advanceUntilIdle()
        assertEquals("AA:BB", model.state.first { it.selected != null }.selected?.address)
    }

    private suspend fun saveSelected(model: PrinterViewModel) {
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        model.state.first { it.selected != null }
    }
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*PrinterViewModelTest' -q
```

Expected: FAIL to compile, `Unresolved reference: PrinterViewModel`.

- [ ] **Step 4: Write the view model**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/PrinterViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.printer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.label.TestLabel
import app.markiro.handheld.core.print.BluetoothPrinterConnector
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.print.WifiPrinterConnector
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

enum class TransportKind(val wire: String) { WIFI("wifi"), BLUETOOTH("bluetooth") }

data class PrinterUi(
    val printers: List<PrinterEntity> = emptyList(),
    val selected: PrinterEntity? = null,
    val paired: List<DiscoveredPrinter> = emptyList(),
    val permissionNeeded: Boolean = false,
)

data class AddPrinterForm(
    val transport: TransportKind = TransportKind.WIFI,
    val host: String = "",
    val port: String = WifiPrinterConnector.DEFAULT_PORT.toString(),
    val language: PrinterLanguage = PrinterLanguage.ZPL,
    val dpi: Int = 203,
    val checking: Boolean = false,
    /** Set when the check came back with something other than a ready printer. */
    val error: NotReadyReason? = null,
)

sealed interface TestPrintStep {
    data object Idle : TestPrintStep
    data object Sending : TestPrintStep
    /** The bytes left the device. The operator now says whether the label is clean. */
    data class Sent(val printerLabel: String) : TestPrintStep
    data class Failed(val reason: NotReadyReason) : TestPrintStep
    /** The link broke partway. Nothing resends from here without a person. */
    data class Unknown(val cause: String) : TestPrintStep
}

@HiltViewModel
class PrinterViewModel(
    private val printers: PrinterDao,
    private val transport: PrinterTransport,
    private val renderer: LabelRenderer,
    private val pairedPrinters: () -> List<DiscoveredPrinter>,
    private val clock: () -> Long,
) : ViewModel() {
    @Inject
    constructor(
        printers: PrinterDao,
        transport: PrinterTransport,
        renderer: LabelRenderer,
        bluetooth: BluetoothPrinterConnector,
    ) : this(printers, transport, renderer, { bluetooth.pairedPrinters() }, System::currentTimeMillis)

    private val local = MutableStateFlow(PrinterUi())
    val state: StateFlow<PrinterUi> = combine(printers.observeAll(), local) { rows, ui ->
        ui.copy(printers = rows, selected = rows.firstOrNull { it.selected })
    }.stateIn(viewModelScope, SharingStarted.Eagerly, PrinterUi())

    private val _addForm = MutableStateFlow(AddPrinterForm())
    val addForm: StateFlow<AddPrinterForm> = _addForm

    private val _testStep = MutableStateFlow<TestPrintStep>(TestPrintStep.Idle)
    val testStep: StateFlow<TestPrintStep> = _testStep

    fun select(id: String) {
        viewModelScope.launch { printers.select(id) }
    }

    fun remove(id: String) {
        viewModelScope.launch { printers.delete(id) }
    }

    fun startAdd(transport: TransportKind) {
        _addForm.value = AddPrinterForm(transport = transport)
    }

    fun editHost(value: String) = _addForm.update { it.copy(host = value, error = null) }

    fun editPort(value: String) = _addForm.update { it.copy(port = value.filter(Char::isDigit), error = null) }

    fun setLanguage(language: PrinterLanguage) = _addForm.update { it.copy(language = language, error = null) }

    fun setDpi(dpi: Int) = _addForm.update { it.copy(dpi = dpi, error = null) }

    /**
     * Asks the printer how it is before saving anything. A printer that answers with a problem keeps
     * the operator on the form with its own words, rather than being saved and failing later.
     */
    fun checkAndSave() {
        val form = _addForm.value
        val port = form.port.toIntOrNull() ?: WifiPrinterConnector.DEFAULT_PORT
        val candidate = PrinterEntity(
            id = UUID.randomUUID().toString(),
            name = form.host.ifBlank { "printer" },
            transport = form.transport.wire,
            address = if (form.transport == TransportKind.WIFI) "${form.host}:$port" else form.host,
            language = form.language.wire,
            dpi = form.dpi,
            selected = true,
            lastStatus = null,
            lastSeenAt = null,
        )
        _addForm.update { it.copy(checking = true, error = null) }
        viewModelScope.launch {
            when (val status = transport.status(candidate)) {
                is PrinterStatus.Ready -> {
                    printers.upsert(candidate.copy(lastStatus = "ready", lastSeenAt = clock()))
                    printers.select(candidate.id)
                    _addForm.value = AddPrinterForm()
                }
                is PrinterStatus.NotReady -> _addForm.update { it.copy(checking = false, error = status.reason) }
            }
        }
    }

    fun loadPairedDevices() {
        viewModelScope.launch {
            val found = runCatching { pairedPrinters() }.getOrElse {
                local.update { ui -> ui.copy(permissionNeeded = true) }
                return@launch
            }
            local.update { it.copy(paired = found, permissionNeeded = false) }
        }
    }

    fun pickPairedDevice(device: DiscoveredPrinter) {
        val form = _addForm.value
        val printer = PrinterEntity(
            id = UUID.randomUUID().toString(),
            name = device.name,
            transport = TransportKind.BLUETOOTH.wire,
            address = device.address,
            language = form.language.wire,
            dpi = form.dpi,
            selected = true,
            lastStatus = null,
            lastSeenAt = null,
        )
        viewModelScope.launch {
            printers.upsert(printer)
            printers.select(printer.id)
        }
    }

    /**
     * Asks the printer how it is, then sends. The question comes first because neither printer
     * language acknowledges a job afterwards: without it the only failure this screen could ever
     * report is silence, and the drawn out-of-paper state could not exist.
     */
    fun printTest() {
        val printer = state.value.selected ?: return
        _testStep.value = TestPrintStep.Sending
        viewModelScope.launch {
            val status = transport.status(printer)
            if (status is PrinterStatus.NotReady) {
                _testStep.value = TestPrintStep.Failed(status.reason)
                printers.setStatus(printer.id, null, clock())
                return@launch
            }
            val document = renderer.render(
                TestLabel.spec(),
                TestLabel.data(),
                PrinterLanguage.fromWire(printer.language),
                printer.dpi,
            )
            _testStep.value = when (val outcome = transport.send(printer, document)) {
                is SendOutcome.Delivered -> TestPrintStep.Sent("${printer.name} · ${printer.address}")
                is SendOutcome.Refused -> TestPrintStep.Failed(outcome.reason)
                is SendOutcome.Unknown -> TestPrintStep.Unknown(outcome.cause)
            }
            printers.setStatus(printer.id, if (_testStep.value is TestPrintStep.Sent) "ready" else null, clock())
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun confirmTestPrinted() {
        _testStep.value = TestPrintStep.Idle
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryTest() = printTest()

    fun dismissTest() {
        _testStep.value = TestPrintStep.Idle
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
./gradlew testDebugUnitTest --tests '*PrinterViewModelTest' -q
```

Expected: PASS. If an assertion reads a state one update too early, wait on the flow with `first { ... }` rather than reading `value`; Room delivers on its own threads.

- [ ] **Step 6: Run the gate and commit**

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors. A missing English string fails lint here, which is the point.

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer apps/handheld/app/src/main/res apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/printer
git commit -m "feat(handheld): printer view model and its strings"
```

---

### Task 13: The five printer screens and navigation

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/PrinterScreens.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/LabelPreview.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/settings/SettingsScreens.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/printer/PrinterScreensTest.kt`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt`

**Interfaces:**

- Consumes: everything Task 12 produces.
- Produces: `PrinterListScreen`, `AddPrinterScreen`, `BluetoothPairScreen`, `TestPrintScreen`, `PrinterErrorScreen`, `LabelPreview`; routes `settings/printer`, `settings/printer/add`, `settings/printer/bluetooth`, `settings/printer/test`.

**A deliberate limitation in the preview.** The drawn test-print screen shows the label. This preview draws the text runs with the same font engine that will rasterize them, and the lines and frames to scale, which is the part that can actually go wrong. The barcode is drawn as a placeholder block of the correct width rather than real bars, because no barcode is ever encoded on this device: both emitters hand the payload to a native printer command. Fake bars would claim a fidelity the preview does not have. A caption says so, and the operator's real check is the paper.

- [ ] **Step 1: Write the failing screen test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/printer/PrinterScreensTest.kt`:

```kotlin
package app.markiro.handheld.feature.printer

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val zebra = PrinterEntity(
        "p1", "Zebra ZD421", "wifi", "192.168.1.40:9100", "zpl", 203,
        selected = true, lastStatus = "ready", lastSeenAt = 1L,
    )
    private val belt = PrinterEntity(
        "p2", "Zebra ZQ320", "bluetooth", "AA:BB", "tspl", 203,
        selected = false, lastStatus = null, lastSeenAt = null,
    )

    @Test
    fun theListShowsTheSelectedPrinterItsSettingsAndTheOthers() {
        var tested = false
        compose.setContent {
            MarkiroTheme {
                PrinterListScreen(
                    PrinterUi(printers = listOf(zebra, belt), selected = zebra),
                    PrinterListCallbacks(onTest = { tested = true }),
                )
            }
        }
        compose.onNodeWithText("ВЫБРАН").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZD421").assertIsDisplayed()
        compose.onNodeWithText("ДОСТУПНЫЕ").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.onNodeWithText("ZPL · 203 dpi").assertIsDisplayed()
        compose.onNodeWithText("Тестовая печать").performClick()
        assertEquals(true, tested)
    }

    @Test
    fun theAddFormOffersBothTransportsAndTheTwoDensities() {
        var checked = false
        compose.setContent {
            MarkiroTheme {
                AddPrinterScreen(AddPrinterForm(host = "192.168.1.40"), AddPrinterCallbacks(onCheck = { checked = true }))
            }
        }
        compose.onNodeWithText("По сети (Wi-Fi)").assertIsDisplayed()
        compose.onNodeWithText("Bluetooth").assertIsDisplayed()
        compose.onNodeWithText("300 dpi").assertIsDisplayed()
        compose.onNodeWithText("Проверить связь").performClick()
        assertEquals(true, checked)
    }

    @Test
    fun aPrinterThatWillNotPrintNamesTheReason() {
        compose.setContent {
            MarkiroTheme {
                AddPrinterScreen(
                    AddPrinterForm(host = "192.168.1.40", error = NotReadyReason.NO_PAPER),
                    AddPrinterCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Нет бумаги").assertIsDisplayed()
    }

    @Test
    fun anUnreachablePrinterNamesItsAddressAndTheTimeout() {
        compose.setContent {
            MarkiroTheme { PrinterErrorScreen("192.168.1.40:9100", PrinterErrorCallbacks()) }
        }
        compose.onNodeWithText("Принтер не отвечает").assertIsDisplayed()
        compose.onNodeWithText("192.168.1.40:9100", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Проверить снова").assertIsDisplayed()
    }

    @Test
    fun aDeliveredTestPrintAsksWhetherTheLabelIsClean() {
        var confirmed = false
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Sent("Zebra ZD421 · 192.168.1.40:9100"),
                    PrinterLanguage.ZPL,
                    203,
                    TestPrintCallbacks(onConfirm = { confirmed = true }),
                )
            }
        }
        compose.onNodeWithText("Тестовая этикетка отправлена").assertIsDisplayed()
        compose.onNodeWithText("Этикетка напечаталась чётко, кириллица и штрих-код читаются?").assertIsDisplayed()
        compose.onNodeWithText("Да, всё чётко").performClick()
        assertEquals(true, confirmed)
    }

    @Test
    fun anUnknownResultOffersConfirmationBeforeAnySecondSend() {
        var confirmed = false
        var retried = false
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Unknown("link lost"),
                    PrinterLanguage.ZPL,
                    203,
                    TestPrintCallbacks(onConfirm = { confirmed = true }, onRetry = { retried = true }),
                )
            }
        }
        compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
        compose.onNodeWithText("Этикетка напечаталась").performClick()
        assertEquals(true, confirmed)
        assertEquals(false, retried)
    }

    @Test
    fun theBluetoothScreenAsksForPermissionBeforeListingAnything() {
        compose.setContent {
            MarkiroTheme {
                BluetoothPairScreen(PrinterUi(permissionNeeded = true), BluetoothPairCallbacks())
            }
        }
        compose.onNodeWithText("Нужен доступ к Bluetooth, чтобы увидеть принтеры.").assertIsDisplayed()
        compose.onNodeWithText("Разрешить").assertIsDisplayed()
    }

    @Test
    fun theBluetoothScreenListsPairedDevices() {
        compose.setContent {
            MarkiroTheme {
                BluetoothPairScreen(
                    PrinterUi(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true))),
                    BluetoothPairCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.onNodeWithText("Выбрать").assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./gradlew testDebugUnitTest --tests '*PrinterScreensTest' -q
```

Expected: FAIL to compile, `Unresolved reference: PrinterListScreen`.

- [ ] **Step 3: Write the label preview**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/LabelPreview.kt`:

```kotlin
package app.markiro.handheld.feature.printer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.dp
import app.markiro.handheld.core.label.BarcodeSource
import app.markiro.handheld.core.label.LabelElement
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.label.LabelSpec
import app.markiro.handheld.core.label.labelFieldDisplayValue
import android.graphics.Paint
import android.graphics.Typeface

/**
 * A picture of what was sent. Text is drawn with the same font engine that rasterizes it for the
 * printer, and the geometry is to scale, which is the part that can go wrong. The barcode is a
 * placeholder block of the right width: no barcode is encoded on this device, both emitters hand the
 * payload to a native printer command, and drawing invented bars would claim a fidelity this
 * preview does not have.
 */
@Composable
fun LabelPreview(spec: LabelSpec, data: Map<LabelField, String>, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(140.dp).background(Color.White).padding(4.dp)) {
        Canvas(Modifier.fillMaxWidth().height(132.dp)) {
            val scale = size.width / spec.widthMm.toFloat()
            fun mm(value: Double) = value.toFloat() * scale
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.BLACK }
            for (element in spec.elements) {
                when (element) {
                    is LabelElement.Box -> drawRect(
                        Color.Black,
                        topLeft = Offset(mm(element.xMm), mm(element.yMm)),
                        size = Size(mm(element.widthMm), mm(element.heightMm)),
                        style = Stroke(width = mm(element.thicknessMm).coerceAtLeast(1f)),
                    )
                    is LabelElement.Line -> drawLine(
                        Color.Black,
                        Offset(mm(element.xMm), mm(element.yMm)),
                        Offset(mm(element.x2Mm), mm(element.y2Mm)),
                        strokeWidth = mm(element.thicknessMm).coerceAtLeast(1f),
                    )
                    is LabelElement.Barcode -> {
                        val value = when (val source = element.data) {
                            is BarcodeSource.Field -> data[source.field] ?: ""
                            is BarcodeSource.Literal -> source.value
                        }
                        // Width from the module arithmetic, filled flat: the printer draws the bars.
                        val modules = 35 + 11 + 11 * ((value.length + 2 + 1) / 2)
                        val width = mm((element.moduleWidthMm ?: 0.25) * modules)
                        drawRect(
                            Color(0xFFBBBBBB),
                            topLeft = Offset(mm(element.xMm), mm(element.yMm)),
                            size = Size(width, mm(element.sizeMm)),
                        )
                    }
                    is LabelElement.Text -> drawContext.canvas.nativeCanvas.drawText(
                        element.text,
                        mm(element.xMm),
                        mm(element.yMm) + mm(element.fontSizePt / 72.0 * 25.4),
                        paint.apply {
                            textSize = mm(element.fontSizePt / 72.0 * 25.4)
                            typeface = Typeface.create(Typeface.SANS_SERIF, if (element.bold == true) Typeface.BOLD else Typeface.NORMAL)
                        },
                    )
                    is LabelElement.Field -> drawContext.canvas.nativeCanvas.drawText(
                        labelFieldDisplayValue(element.field, data, element.textFormat),
                        mm(element.xMm),
                        mm(element.yMm) + mm(element.fontSizePt / 72.0 * 25.4),
                        paint.apply {
                            textSize = mm(element.fontSizePt / 72.0 * 25.4)
                            typeface = Typeface.create(Typeface.SANS_SERIF, if (element.bold == true) Typeface.BOLD else Typeface.NORMAL)
                        },
                    )
                }
            }
        }
    }
}
```

- [ ] **Step 4: Write the screens**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/printer/PrinterScreens.kt` with five composables and their callback holders. Follow the layout conventions already in `feature/settings/SettingsScreens.kt`: a scrolling `Column` on `MarkiroTheme.colors.surfacePage`, an `AppBar` with a back action, section captions in `MarkiroTheme.type.label` coloured `fg3`, rows of `MarkiroSizes.controlRow` height, `PrimaryButton` for the one main action and `SecondaryButton` or `MarkiroTextButton` below it.

```kotlin
package app.markiro.handheld.feature.printer

data class PrinterListCallbacks(
    val onBack: () -> Unit = {},
    val onSelect: (String) -> Unit = {},
    val onRemove: (String) -> Unit = {},
    val onLanguageAndDpi: () -> Unit = {},
    val onTest: () -> Unit = {},
    val onAdd: () -> Unit = {},
)

data class AddPrinterCallbacks(
    val onBack: () -> Unit = {},
    val onTransport: (TransportKind) -> Unit = {},
    val onHost: (String) -> Unit = {},
    val onPort: (String) -> Unit = {},
    val onLanguage: (PrinterLanguage) -> Unit = {},
    val onDpi: (Int) -> Unit = {},
    val onCheck: () -> Unit = {},
    val onBluetooth: () -> Unit = {},
)

data class BluetoothPairCallbacks(
    val onBack: () -> Unit = {},
    val onGrant: () -> Unit = {},
    val onSearchAgain: () -> Unit = {},
    val onPick: (DiscoveredPrinter) -> Unit = {},
)

data class TestPrintCallbacks(
    val onBack: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onRetry: () -> Unit = {},
)

data class PrinterErrorCallbacks(val onBack: () -> Unit = {}, val onRetry: () -> Unit = {}, val onEdit: () -> Unit = {})
```

The list screen in full, as the template the other four follow:

```kotlin
@Composable
fun PrinterListScreen(state: PrinterUi, cb: PrinterListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.printer_title), cb.onBack)
        Column(
            Modifier.padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            state.selected?.let { printer ->
                Text(stringResource(R.string.printer_selected), style = t.label, color = c.fg3)
                PrinterRow(printer, selected = true, onClick = {})
            }
            val others = state.printers.filterNot { it.selected }
            if (others.isNotEmpty()) {
                Text(stringResource(R.string.printer_available), style = t.label, color = c.fg3)
                others.forEach { printer ->
                    PrinterRow(printer, selected = false, onClick = { cb.onSelect(printer.id) })
                }
            }
            state.selected?.let { printer ->
                SettingRow(
                    stringResource(R.string.printer_language_and_dpi),
                    stringResource(R.string.printer_language_dpi_value, printer.language.uppercase(), printer.dpi),
                    cb.onLanguageAndDpi,
                )
                PrimaryButton(stringResource(R.string.printer_test), cb.onTest)
            }
            MarkiroTextButton(stringResource(R.string.printer_add_by_address), cb.onAdd)
        }
    }
}

@Composable
private fun PrinterRow(printer: PrinterEntity, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard)
            .border(1.dp, if (selected) c.accent else c.line, shape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) { if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent)) }
        Column(Modifier.weight(1f)) {
            Text(printer.name, style = t.body, color = c.fg1)
            Text(
                listOfNotNull(
                    if (printer.transport == "bluetooth") "Bluetooth" else "Wi-Fi",
                    printer.address,
                    printer.lastStatus,
                ).joinToString(" · "),
                style = t.caption,
                color = c.fg2,
            )
        }
    }
}
```

`SettingRow` currently lives as a private helper in `feature/settings/SettingsScreens.kt`. Change its visibility to `internal` and import it here rather than copying it, so the two settings surfaces cannot drift apart.

Each remaining screen, in the order drawn:

- `AddPrinterScreen(form: AddPrinterForm, cb: AddPrinterCallbacks)` — two `OptionRow`-shaped choices for the transport with their hint lines, then for Wi-Fi a host field and a port field side by side, then two segmented rows for language and density, then `PrimaryButton(printer_check)` disabled while `form.checking`. When `form.error` is not null, show the matching string above the button: `printer_no_paper`, `printer_head_open`, `printer_not_ready`, and for `UNREACHABLE` navigate to `PrinterErrorScreen` instead. Choosing Bluetooth calls `onBluetooth`.
- `BluetoothPairScreen(state: PrinterUi, cb: BluetoothPairCallbacks)` — when `state.permissionNeeded`, only the `printer_bluetooth_permission` line and `PrimaryButton(printer_bluetooth_grant)`. Otherwise the hint, the `printer_bluetooth_found` caption, one row per paired device with its address underneath and a `printer_bluetooth_pick` action, `printer_bluetooth_empty` when the list is empty, and `SecondaryButton(printer_bluetooth_search_again)` at the bottom.
- `TestPrintScreen(step: TestPrintStep, language: PrinterLanguage, dpi: Int, cb: TestPrintCallbacks)` — `Sending` shows `printer_test_sending`. `Sent` shows a card with `printer_test_sent` and the printer label, then `LabelPreview(TestLabel.spec(), TestLabel.data())`, then `printer_test_question`, `PrimaryButton(printer_test_yes)` calling `onConfirm` and `SecondaryButton(printer_test_no)` calling `onRetry`. `Unknown` shows `printer_test_unknown_title` and `printer_test_unknown_body` in the attention tone, then `PrimaryButton(printer_test_unknown_confirm)` calling `onConfirm` and `SecondaryButton(printer_test_unknown_again)` calling `onRetry`. `Failed` shows `printer_test_failed` with the reason string and `SecondaryButton(printer_check_again)` calling `onRetry`.
- `PrinterErrorScreen(address: String, cb: PrinterErrorCallbacks)` — `printer_unreachable_title`, then `printer_unreachable_body` formatted with the address and `PRINTER_TIMEOUT_MS / 1000`, then `PrimaryButton(printer_check_again)` and `MarkiroTextButton(printer_edit_address)`.

In `Unknown` the confirm action must be the primary one and must not call `onRetry`. That ordering is the whole point of the state: the cheap, safe action is confirming what the operator can already see, and sending again is the deliberate one.

- [ ] **Step 5: Wire navigation and the settings row**

In `AppNavigation.kt` add to `Routes`:

```kotlin
    const val PRINTER = "settings/printer"
    const val PRINTER_ADD = "settings/printer/add"
    const val PRINTER_BLUETOOTH = "settings/printer/bluetooth"
    const val PRINTER_TEST = "settings/printer/test"
```

Add four `composable(...)` entries beside the existing `Routes.SCANNER` one, each taking `val vm: PrinterViewModel = hiltViewModel()`, collecting the flows it needs with `collectAsStateWithLifecycle()`, and passing `nav.popBackStack()` as `onBack`. `AddPrinterScreen`'s `onBluetooth` navigates to `Routes.PRINTER_BLUETOOTH`; `BluetoothPairScreen` calls `vm.loadPairedDevices()` in a `LaunchedEffect(Unit)` and pops back after `onPick`. `PrinterListScreen`'s `onTest` calls `vm.printTest()` and navigates to `Routes.PRINTER_TEST`.

In `feature/settings/SettingsScreens.kt` add an `onPrinter: () -> Unit` parameter to `SettingsScreen` and a row beneath the scanner row:

```kotlin
            SettingRow(
                stringResource(R.string.printer_title),
                state.printerLabel ?: stringResource(R.string.printer_none),
                onPrinter,
            )
```

Add `printerLabel: String? = null` to `SettingsUi` and fill it in `SettingsViewModel` by collecting `printerDao.observeSelected()`, formatting as `"${printer.name} · ${printer.language.uppercase()} ${printer.dpi} dpi"`. Pass `onPrinter = { nav.navigate(Routes.PRINTER) }` from `AppNavigation.kt`.

- [ ] **Step 6: Extend the English render test**

In `apps/handheld/app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt` add three tests following the existing shape, each calling `assertNoCyrillic()` after setting content: the printer list with one Wi-Fi printer whose name is Latin, the add form, and the test-print screen in its `Unknown` state.

- [ ] **Step 7: Run the tests, then the gate**

```bash
./gradlew testDebugUnitTest --tests '*PrinterScreensTest' --tests '*EnglishRenderTest' -q
```

Expected: PASS.

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

- [ ] **Step 8: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld apps/handheld/app/src/test/kotlin/app/markiro/handheld
git commit -m "feat(handheld): printer screens, label preview and navigation"
```

---

### Task 14: Hub and status strip, documentation, and the whole-repository gate

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub/HubViewModel.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub/HubScreen.kt`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/hub/HubViewModelTest.kt`
- Modify: `apps/handheld/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-09-10-handheld-printing-design.md` (status line only)

**Interfaces:**

- Consumes: `PrinterDao` from Task 9.
- Produces: nothing new. This task makes the two places that already claim to know about a printer tell the truth.

- [ ] **Step 1: Make the hub and the status strip honest**

The settings tile currently always claims no printer is configured. Add the flag to `HubUi`:

```kotlin
    val printerConfigured: Boolean = false,
```

In `HubViewModel`, inject `printers: PrinterDao` and fold its selection into the combined state, next to the existing sources:

```kotlin
        printers.observeSelected(),
```

reading it in the combine block as `printerConfigured = v[N] != null` where `N` is its index, and passing it into `HubUi`.

In `HubScreen.kt`, the settings tile's status argument becomes conditional:

```kotlin
                    if (state.printerConfigured) "" else stringResource(R.string.hub_printer_not_set),
```

The status strip's printer indicator is built in `WorkScreen.kt` and in `InventoryWorkScreen.kt` as `StatusItem(Icons.Outlined.Print, stringResource(R.string.hub_printer))`. Give it a tone:

```kotlin
                StatusItem(
                    Icons.Outlined.Print,
                    stringResource(R.string.hub_printer),
                    tone = if (state.printerConfigured) Tone.Neutral else Tone.Warn,
                )
```

Add the same `printerConfigured` flag to `WorkUi` and `InventoryWorkUi` and fill it from `PrinterDao.observeSelected()` in their view models. Reading the database from a composable would be quicker and wrong.

- [ ] **Step 2: Extend the hub test**

In `HubViewModelTest.kt` add a case that inserts a selected printer and asserts `printerConfigured` becomes true, and one with no rows asserting it stays false. Follow the existing pattern of waiting on the flow with `first { }` rather than reading `value`.

- [ ] **Step 3: Document the contour**

In `apps/handheld/README.md`, add the printing spec to the slice list at the top and a section after the inventory walk-through:

```markdown
## Printing

The handheld renders labels itself. `core/label` is a Kotlin port of the ZPL and TSPL emitters in
`packages/domain`, pinned to them by fixtures: run
`pnpm --filter @markiro/domain fixtures:labels` after changing either side, and
`app/src/test/resources/label-fixtures.json` is what the Kotlin tests assert against.

Text inside printable ASCII is emitted as native printer commands and matches the TypeScript source
character for character. Text outside it, which on this market means every Cyrillic product name, is
rasterized with Android's own font engine and cannot match the station's pixels: the station and the
cabinet editor share one implementation and are deliberately identical to each other, and this is a
third. The fixtures pin command framing and bitmap dimensions for those cases, never glyph pixels.

Printers live only on this device, in the `printers` table, following the rule stated in
`apps/station/src/lib/hardware-config.ts`. Settings → Принтер adds one over Wi-Fi by address or over
Bluetooth from the paired devices, and prints a test label carrying a Cyrillic line and an SSCC
barcode, which is the pair that can actually go wrong.

A send has three outcomes and the last two differ in a way that matters: refused means nothing was
printed and we know it, unknown means the bytes may or may not have arrived. Nothing resends from
unknown on its own, because a retry could put a second label on a box the server already accepted.
```

In `docs/architecture.md`, extend the handheld entry to mention that it renders labels on the device and prints over Wi-Fi or Bluetooth with no hardware agent.

Set the spec's status line to `**Status:** Implemented in <pull request URL> (2026-09-10)` once the pull request exists.

- [ ] **Step 4: Run the whole-repository gate**

From `apps/handheld`:

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, zero lint errors.

From the repository root:

```bash
pnpm --filter @markiro/domain --config.verify-deps-before-run=false test
```

Expected: all suites pass.

```bash
pnpm exec prettier --check apps/handheld/README.md docs/architecture.md docs/superpowers/specs/2026-09-10-handheld-printing-design.md docs/superpowers/plans/2026-09-10-handheld-printing.md packages/domain
```

Expected: `All matched files use Prettier code style!`.

- [ ] **Step 5: Verify on the emulator against a socket that stands in for a printer**

This is what turns the port claim into evidence. Start a listener on the host that keeps whatever it receives:

```bash
nc -l 9100 > /tmp/claude/printer-capture.bin
```

Boot the API 36 emulator, pair the app as before, then in Settings → Принтер → Добавить по адресу enter `10.0.2.2` and port `9100`, language ZPL, density 203, and check the connection. Print the test label. Then compare the captured bytes against what the TypeScript emitter produces for the same spec, language and resolution. They must be identical up to the image payloads, and the image commands must carry the same dimensions.

Then exercise the three outcomes:

- Point the printer at a closed port and check the connection. Expected: the not-responding screen naming the address and five seconds.
- With the listener running, stop it mid-transfer. Expected: the unknown state, with confirm as the primary action and nothing resent until it is chosen.
- Switch the app to English and walk the same five screens. Expected: no Cyrillic except a printer name the operator typed.

Record what was checked, and record plainly that Bluetooth was not: an emulator has no radio.

- [ ] **Step 6: Commit and open the pull request**

```bash
git add apps/handheld docs
git commit -m "feat(handheld): wire the printer into the hub and status strip, document the contour"
git push -u origin worktree-tsd-printing
```

The pull request body states the automated gates, the emulator walk-through, and, under a heading of its own, what was not exercised: Bluetooth on hardware, and the glyph-level appearance of rasterized Cyrillic, which only a printed label can answer.

---

## Notes for the reviewer

Three places in this plan are where a port most often goes quietly wrong, and each has a test that would catch it:

- Rounding direction on millimetre conversion. `LabelUnitsTest` pins a value that lands exactly on a half dot, and a negative one.
- Bit polarity between the two languages. `MonochromeTest` pins the inversion including the padding bits.
- The width contract on rasterized text. `LabelRendererTest` pins that the bitmap never exceeds its box, which is what keeps a long Cyrillic name on the label.

One decision is worth re-reading before starting: the label preview on the test-print screen draws real text and real geometry but a placeholder for the barcode, because no barcode is encoded on this device. See Task 13.
