# Handheld box aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The handheld enters an aggregation shift, fills and closes boxes with SSCCs from its own pool, prints the box label, recovers from every print failure, and reports the closures in the batch the station already uses.

**Architecture:** A new `core/box` package holds the pure rules (SSCC construction, label-date arithmetic, the close pipeline) and the device-local state (box rows, SSCC pool). The existing scan path gains a box id; the existing sync path gains a `boxes[]` array and a second pinned ceiling. The work screen gains a fill grid, the close states and a deferred-label queue. No server change.

**Tech Stack:** Kotlin 2.2, Jetpack Compose/Material3, Hilt, Room 2.7.2, kotlinx.coroutines, Robolectric/JUnit4. TypeScript fixtures exported from `@markiro/domain`.

## Global Constraints

- **No server change.** `POST /station/scans` already accepts `items[].boxId` and `boxes[]`; the shift bundle already carries `boxLabelTemplate` and the SSCC block.
- **Gate for every handheld task**, run from `apps/handheld`: `./gradlew testDebugUnitTest lintDebug assembleDebug`.
- **Both languages.** Every user-visible string exists in `app/src/main/res/values/strings.xml` and `app/src/main/res/values-en/strings.xml`. A missing translation is a lint error.
- **A serial is burned at close, never at open.** An empty box and an abandoned box cost nothing.
- **Two boxes must never share an SSCC.** On the handheld this is a `Mutex` plus `db.withTransaction`, not the station's single `UPDATE ... RETURNING`: `minSdk = 28` means SQLite 3.22, and `RETURNING` needs 3.35. The station needed one statement because `tauri-plugin-sql` pools connections so `BEGIN`/`COMMIT` across calls is not a transaction; Room gives a real one.
- **A block is accepted with `nextSerial = MAX(existing, incoming)`, never "insert if absent".** The server always reports a block's ORIGINAL bounds plus `consumedThroughSerial`.
- **Revoked ranges are deleted, not exhausted.** Burning picks the lowest `fromSerial` with room, so a revoked block left in place keeps winning over its replacement.
- **`closedAt` is the label's date source**, persisted on the box row and never recomputed at render time.
- **Labels are re-rendered at print time, never stored as bytes.**
- **`printVerifiedAt` and `printSkippedAt` are always sent null.** Print verification is not in this slice.
- **Box acknowledgement is unconditional, by pinned ceiling.**
- **A `printing` row found at startup is read as `unknown`, never resumed.**
- **`unknown` never resends by itself, and «Напечатать все» skips it.**
- **SSCC is stored and transported as bare 18 digits.** The `(00)` application identifier is added by the emitter and nowhere else.
- **Expiry is the last usable day, inclusive:** production day is day one, so `productionDate + N - 1`.
- **The fill grid becomes a large counter above 60 units.**

---

## File Structure

**`packages/domain`** (TypeScript)

| File                                             | Responsibility                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/labels/box-label.ts` (create)               | `BoxLabelInput`, `localIsoDate`, `effectiveProductionIsoDate`, `expiryIsoDate`, `boxLabelFields` — moved from the station so two apps do not each own the rule |
| `src/labels/box-label-fixtures.ts` (create)      | `buildBoxLabelFixtures()`                                                                                                                                      |
| `scripts/export-box-label-fixtures.mjs` (create) | Writes the JSON into the handheld's test resources                                                                                                             |
| `test/box-label-fixtures.test.ts` (create)       | Drift guard                                                                                                                                                    |

**`apps/station`** — `src/lib/box-label.ts` becomes a re-export.

**`apps/handheld` — `core/box`** (all new)

| File                | Responsibility                                                           |
| ------------------- | ------------------------------------------------------------------------ |
| `Sscc.kt`           | `buildSscc`, `ssccSerialCapacity`, `SsccException`                       |
| `BoxLabelFields.kt` | Calendar arithmetic and the field record                                 |
| `SsccPool.kt`       | `addRange`, `dropRanges`, `burnSerial`, `remaining`                      |
| `BoxRepository.kt`  | `currentBox`, `openBox`, `ordinal`, `closeBox`, print marks, queue query |
| `CloseBox.kt`       | The close pipeline and its four results                                  |
| `BoxPrinter.kt`     | Render, print, map the outcome onto the box row                          |
| `BoxModule.kt`      | Hilt bindings                                                            |

**`apps/handheld` — modified**

`core/storage/BoxEntities.kt` + `BoxDaos.kt` (create), `ShiftEntities.kt`, `HandheldDatabase.kt`, `Migrations.kt`, `DeviceWipe.kt`, `core/scan/ScanRecorder.kt`, `core/sync/SyncEngine.kt`, `core/sync/SyncDtos.kt`, `core/signal/Signaller.kt`, `core/network/ShiftDtos.kt`, `feature/shift/ShiftRepository.kt`, `feature/work/WorkViewModel.kt`, `feature/work/WorkScreen.kt`, `AppNavigation.kt`, `feature/hub/*`, both `strings.xml`.

**`apps/handheld` — new UI**: `feature/work/BoxFill.kt`, `feature/work/BoxCloseScreens.kt`, `feature/work/LabelQueueScreen.kt`, `feature/work/LabelQueueViewModel.kt`.

---

### Task 1: Move box-label composition into `@markiro/domain`

The handheld is about to compute box-label fields, and the root `AGENTS.md` forbids two apps owning one label rule. The station keeps its import sites unchanged.

**Files:**

- Create: `packages/domain/src/labels/box-label.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/station/src/lib/box-label.ts` (replace the body with a re-export)
- Test: `packages/domain/test/box-label.test.ts` (create)

**Interfaces:**

- Produces: `BoxLabelInput`, `localIsoDate(instant: string): string`, `effectiveProductionIsoDate(closedAt: string, productionDate: string | null): string`, `expiryIsoDate(closedAt: string, shelfLifeDays: number | null, productionDate?: string | null): string`, `boxLabelFields(input: BoxLabelInput): Record<LabelField, string>`

- [ ] **Step 1: Move the file**

Copy `apps/station/src/lib/box-label.ts` to `packages/domain/src/labels/box-label.ts` verbatim, then change its imports from `@markiro/domain` to relative ones:

```ts
import { addCalendarDays, shelfLifeExpiryDate } from "./shelf-life.js";
import { formatLabelDate } from "./date.js";
import type { LabelField } from "./model.js";
```

Delete the `export { addCalendarDays } from "@markiro/domain";` line — domain already exports it from `index.ts`.

- [ ] **Step 2: Export it from the domain barrel**

In `packages/domain/src/index.ts`, next to the existing `export { addCalendarDays, shelfLifeExpiryDate } from "./labels/shelf-life.js";`:

```ts
export {
  boxLabelFields,
  effectiveProductionIsoDate,
  expiryIsoDate,
  localIsoDate,
} from "./labels/box-label.js";
export type { BoxLabelInput } from "./labels/box-label.js";
```

- [ ] **Step 3: Turn the station's file into a re-export**

Replace the whole body of `apps/station/src/lib/box-label.ts` with:

```ts
/**
 * Box-label field composition now lives in `@markiro/domain`: the handheld
 * computes the same fields, and one rule owned by two apps is exactly what
 * the root AGENTS.md forbids. Re-exported here so every existing import site
 * in the station keeps working.
 */
export {
  addCalendarDays,
  boxLabelFields,
  effectiveProductionIsoDate,
  expiryIsoDate,
  localIsoDate,
} from "@markiro/domain";
export type { BoxLabelInput } from "@markiro/domain";
```

- [ ] **Step 4: Add a domain test that pins the inclusive-expiry rule**

Create `packages/domain/test/box-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boxLabelFields, effectiveProductionIsoDate, expiryIsoDate } from "../src/index.js";

const base = {
  sscc: "046800899000000000",
  itemCount: 20,
  productName: "Вода питьевая 0,5 л",
  productPrintName: null,
  gtin14: "04680089900000",
  egaisCode: null,
  shelfLifeDays: 365,
  operatorName: "Иванов И.",
  counterpartyName: null,
  closedAt: "2026-09-10T08:00:00.000Z",
  productionDate: "2026-09-10",
  shiftNumber: "SEP26-003",
};

describe("boxLabelFields", () => {
  it("counts the production day as day one", () => {
    // 2026-09-10 + 365 days of shelf life is usable through 2027-09-09, not -10.
    expect(expiryIsoDate("2026-09-10T08:00:00.000Z", 365, "2026-09-10")).toBe("2027-09-09");
  });

  it("prints dates as DD.MM.YYYY and the SSCC bare", () => {
    const fields = boxLabelFields(base);
    expect(fields.date).toBe("10.09.2026");
    expect(fields.expiry).toBe("09.09.2027");
    expect(fields.sscc).toBe("046800899000000000");
    expect(fields.qty).toBe("20");
  });

  it("falls back to the full product name when there is no print name", () => {
    expect(boxLabelFields(base)["product.printName"]).toBe("Вода питьевая 0,5 л");
  });

  it("uses the close date when no production date was declared", () => {
    expect(effectiveProductionIsoDate("2026-09-10T08:00:00.000Z", null)).toBe(
      expiryIsoDate("2026-09-10T08:00:00.000Z", 1),
    );
  });

  it("leaves the expiry empty when there is no shelf life", () => {
    expect(boxLabelFields({ ...base, shelfLifeDays: null }).expiry).toBe("");
  });
});
```

- [ ] **Step 5: Run domain and station gates**

```bash
pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build
```

Expected: all pass.

```bash
pnpm --filter @markiro/station exec vitest run test/box-label.test.ts test/close-box.test.ts test/inventory-box-label.test.ts
```

Expected: all pass unchanged — the re-export is behaviour-neutral.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/labels/box-label.ts packages/domain/src/index.ts packages/domain/test/box-label.test.ts apps/station/src/lib/box-label.ts
git commit -m "refactor(domain): own box-label field composition"
```

---

### Task 2: Box-label fixtures, and the Kotlin SSCC and date port

**Files:**

- Create: `packages/domain/src/labels/box-label-fixtures.ts`
- Create: `packages/domain/scripts/export-box-label-fixtures.mjs`
- Create: `packages/domain/test/box-label-fixtures.test.ts`
- Modify: `packages/domain/package.json`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/Sscc.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxLabelFields.kt`
- Create: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/BoxLabelFixturesTest.kt`

**Interfaces:**

- Consumes: `boxLabelFields`, `buildSscc` from Task 1 and `@markiro/domain`
- Produces (Kotlin): `Sscc.build(extensionDigit: Int, gs1Prefix: String, serial: Long): String`, `Sscc.serialCapacity(gs1Prefix: String): Long`, `SsccException(val code: String, message: String)`, `BoxLabelInput` data class, `boxLabelFields(input: BoxLabelInput): Map<LabelField, String>`

- [ ] **Step 1: Write the fixture builder**

Create `packages/domain/src/labels/box-label-fixtures.ts`:

```ts
import { buildSscc } from "../gs1/sscc.js";
import { boxLabelFields, type BoxLabelInput } from "./box-label.js";
import type { LabelField } from "./model.js";

export interface SsccCase {
  extensionDigit: number;
  gs1Prefix: string;
  serial: number;
  /** The 18-digit result, or null when the domain refuses the input. */
  sscc: string | null;
  /** The `DomainError` code when `sscc` is null. */
  error: string | null;
}

export interface FieldCase {
  name: string;
  input: BoxLabelInput;
  fields: Record<LabelField, string>;
}

export interface BoxLabelFixtures {
  /**
   * The zone the field cases were generated in. `localIsoDate` resolves a
   * stored UTC instant against the machine's own zone, so a fixture is only
   * reproducible when the reader applies the same one. The export script
   * pins it; the Kotlin test applies it.
   */
  timeZone: string;
  sscc: SsccCase[];
  fields: FieldCase[];
}

function sscc(extensionDigit: number, gs1Prefix: string, serial: number): SsccCase {
  try {
    return {
      extensionDigit,
      gs1Prefix,
      serial,
      sscc: buildSscc(extensionDigit, gs1Prefix, serial),
      error: null,
    };
  } catch (err) {
    return {
      extensionDigit,
      gs1Prefix,
      serial,
      sscc: null,
      error: (err as { code?: string }).code ?? "UNKNOWN",
    };
  }
}

const product: Omit<BoxLabelInput, "closedAt" | "productionDate" | "shelfLifeDays"> = {
  sscc: "046800899000000000",
  itemCount: 20,
  productName: "Вода питьевая негазированная 0,5 л",
  productPrintName: "Вода 0,5 л",
  gtin14: "04680089900000",
  egaisCode: null,
  operatorName: "Иванов И.",
  counterpartyName: "ООО «Завод»",
  shiftNumber: "SEP26-003",
};

function field(
  name: string,
  overrides: Partial<BoxLabelInput> & Pick<BoxLabelInput, "closedAt">,
): FieldCase {
  const input: BoxLabelInput = {
    ...product,
    shelfLifeDays: 365,
    productionDate: null,
    ...overrides,
  };
  return { name, input, fields: boxLabelFields(input) };
}

export function buildBoxLabelFixtures(): BoxLabelFixtures {
  return {
    timeZone: "UTC",
    sscc: [
      sscc(0, "468008990", 0),
      sscc(0, "468008990", 1),
      sscc(0, "468008990", 4_242),
      sscc(0, "468008990", 9_999_999),
      sscc(1, "468008990", 7),
      sscc(0, "4600000", 123_456_789),
      // Refusals: the serial is past the prefix's capacity, and the digit is not a digit.
      sscc(0, "468008990", 10_000_000),
      sscc(0, "468008990", -1),
      sscc(10, "468008990", 5),
      sscc(0, "46800", 0),
    ],
    fields: [
      field("declared production date", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
      }),
      field("close date stands in for an undeclared production date", {
        closedAt: "2026-09-10T21:30:00.000Z",
      }),
      field("one-day shelf life expires on the production day", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        shelfLifeDays: 1,
      }),
      field("leap day", {
        closedAt: "2028-02-29T08:00:00.000Z",
        productionDate: "2028-02-29",
        shelfLifeDays: 366,
      }),
      field("crossing a year boundary", {
        closedAt: "2026-12-31T08:00:00.000Z",
        productionDate: "2026-12-31",
        shelfLifeDays: 30,
      }),
      field("no shelf life leaves the expiry empty", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        shelfLifeDays: null,
      }),
      field("an impossible declared date yields empty dates", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-02-30",
      }),
      field("no print name falls back to the full name", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        productPrintName: null,
      }),
      field("absent optionals become empty strings", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        operatorName: null,
        counterpartyName: null,
        shiftNumber: null,
        egaisCode: null,
      }),
    ],
  };
}
```

- [ ] **Step 2: Write the export script**

Create `packages/domain/scripts/export-box-label-fixtures.mjs`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `localIsoDate` reads the machine's zone, so the fixture is reproducible only
// under a pinned one. Set before importing anything that touches Date.
process.env.TZ = "UTC";

const { buildBoxLabelFixtures } = await import("../dist/labels/box-label-fixtures.js");

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../apps/handheld/app/src/test/resources/box-label-fixtures.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(buildBoxLabelFixtures(), null, 2)}\n`, "utf8");
console.log(`wrote ${out}`);
```

- [ ] **Step 3: Add the script to the manifest**

In `packages/domain/package.json`, next to `"fixtures:labels"`:

```json
"fixtures:box-labels": "pnpm run build && TZ=UTC node scripts/export-box-label-fixtures.mjs"
```

- [ ] **Step 4: Write the drift test**

Create `packages/domain/test/box-label-fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoxLabelFixtures } from "../src/labels/box-label-fixtures.js";

const FIXTURES = resolve(
  import.meta.dirname,
  "../../../apps/handheld/app/src/test/resources/box-label-fixtures.json",
);

describe("box label fixtures", () => {
  it("matches the committed file", () => {
    // Regenerate with `pnpm --filter @markiro/domain fixtures:box-labels`.
    // Failing here means the Kotlin port is now pinned to something the
    // emitter no longer produces.
    const committed = JSON.parse(readFileSync(FIXTURES, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildBoxLabelFixtures())));
  });

  it("covers both a refusal and a leap day", () => {
    const built = buildBoxLabelFixtures();
    expect(built.sscc.some((c) => c.error === "SSCC_RANGE")).toBe(true);
    expect(built.fields.some((c) => c.name.includes("leap"))).toBe(true);
  });
});
```

- [ ] **Step 5: Generate and run the domain gate**

```bash
pnpm --filter @markiro/domain fixtures:box-labels && pnpm --filter @markiro/domain test
```

Expected: the JSON is written and every test passes. The test file runs under `TZ=UTC` because the fixture pins it; if vitest runs in another zone the drift test still passes, because `buildBoxLabelFixtures` is compared against itself — the pinned zone matters only to the Kotlin reader.

- [ ] **Step 6: Write the Kotlin SSCC port**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/Sscc.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.km.KmCodec

/** Refusals carry the domain's own codes, because the fixtures pin them. */
class SsccException(val code: String, message: String) : Exception(message)

/**
 * Port of `packages/domain/src/gs1/sscc.ts`. Pinned by `box-label-fixtures.json`:
 * a check digit that disagrees with the domain is a label carrying a number
 * that will not reconcile at the receiver.
 */
object Sscc {
    private val PREFIX = Regex("^\\d{4,12}$")

    /** Serials available per prefix and extension: the serial field is 16 - |prefix| digits. */
    fun serialCapacity(gs1Prefix: String): Long {
        if (!PREFIX.matches(gs1Prefix)) throw SsccException("SSCC_PREFIX", "bad GS1 prefix: \"$gs1Prefix\"")
        var capacity = 1L
        repeat(16 - gs1Prefix.length) { capacity *= 10 }
        return capacity
    }

    fun build(extensionDigit: Int, gs1Prefix: String, serial: Long): String {
        if (extensionDigit !in 0..9) throw SsccException("SSCC_PREFIX", "bad extension digit: $extensionDigit")
        val capacity = serialCapacity(gs1Prefix)
        if (serial < 0 || serial >= capacity) {
            throw SsccException("SSCC_RANGE", "serial $serial outside 0..${capacity - 1}")
        }
        val body = "$extensionDigit$gs1Prefix" + serial.toString().padStart(16 - gs1Prefix.length, '0')
        return body + KmCodec.checkDigit(body)
    }
}
```

- [ ] **Step 7: Write the Kotlin label-field port**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxLabelFields.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelField
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException

/**
 * Port of `packages/domain/src/labels/box-label.ts`, pinned by
 * `box-label-fixtures.json`.
 *
 * Every function here is tolerant on purpose, exactly like the source: a label
 * must never fail to print because of a date, so a malformed one becomes an
 * empty field rather than an exception.
 */
data class BoxLabelInput(
    val sscc: String,
    val itemCount: Int,
    val productName: String,
    val productPrintName: String?,
    val gtin14: String,
    val egaisCode: String?,
    val shelfLifeDays: Int?,
    val operatorName: String?,
    val counterpartyName: String?,
    /** The stored UTC instant of the box's own closure. */
    val closedAt: String,
    val productionDate: String?,
    val shiftNumber: String?,
)

private val ISO_DATE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")

/**
 * Plain calendar-day addition on `YYYY-MM-DD`. No timezone is involved: the
 * arithmetic runs on the calendar itself, so a daylight-saving transition
 * inside the window can never shift the printed day by one.
 *
 * Returns "" for a malformed or non-existent date such as `2026-02-30`.
 */
fun addCalendarDays(isoDate: String, days: Int): String {
    val match = ISO_DATE.matchEntire(isoDate) ?: return ""
    val (year, month, day) = match.destructured
    val date = try {
        LocalDate.of(year.toInt(), month.toInt(), day.toInt())
    } catch (_: Exception) {
        return ""
    }
    val moved = try {
        date.plusDays(days.toLong())
    } catch (_: Exception) {
        return ""
    }
    if (moved.year < 1 || moved.year > 9999) return ""
    return "%04d-%02d-%02d".format(moved.year, moved.monthValue, moved.dayOfMonth)
}

/** Last usable calendar day, inclusive: the production day is day one. */
fun shelfLifeExpiryDate(productionDate: String, shelfLifeDays: Int?): String {
    if (shelfLifeDays == null || shelfLifeDays <= 0) return ""
    return addCalendarDays(productionDate, shelfLifeDays - 1)
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`; anything else is returned unchanged. */
fun formatLabelDate(isoDate: String): String {
    val match = ISO_DATE.matchEntire(isoDate) ?: return isoDate
    val (year, month, day) = match.destructured
    return "$day.$month.$year"
}

/**
 * The LOCAL calendar date of a stored UTC instant. Storage keeps UTC, and a
 * box label is read by a person standing next to the device, so the day it
 * prints is the device's own day.
 */
fun localIsoDate(instant: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val parsed = try {
        Instant.parse(instant)
    } catch (_: DateTimeParseException) {
        return ""
    }
    val date = parsed.atZone(zone).toLocalDate()
    return "%04d-%02d-%02d".format(date.year, date.monthValue, date.dayOfMonth)
}

/**
 * The declared production date when present, otherwise the box's local close
 * date. An invalid declared date returns "" rather than falling back and
 * hiding corrupt data.
 */
fun effectiveProductionIsoDate(
    closedAt: String,
    productionDate: String?,
    zone: ZoneId = ZoneId.systemDefault(),
): String = if (productionDate != null) addCalendarDays(productionDate, 0) else localIsoDate(closedAt, zone)

/**
 * `sscc` is the BARE 18 digits: the `(00)` application identifier is added by
 * the emitter and nowhere else, because storing or transporting it gets an
 * export to «Честный знак» rejected.
 */
fun boxLabelFields(input: BoxLabelInput, zone: ZoneId = ZoneId.systemDefault()): Map<LabelField, String> {
    val effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate, zone)
    val effectiveExpiry = shelfLifeExpiryDate(effectiveDate, input.shelfLifeDays)
    return mapOf(
        LabelField.PRODUCT_NAME to input.productName,
        LabelField.PRODUCT_PRINT_NAME to (input.productPrintName ?: input.productName),
        LabelField.PRODUCT_GTIN to input.gtin14,
        LabelField.PRODUCT_EGAIS to (input.egaisCode ?: ""),
        LabelField.KM_CODE to "",
        LabelField.SSCC to input.sscc,
        LabelField.SHIFT_NO to (input.shiftNumber ?: ""),
        LabelField.DATE to formatLabelDate(effectiveDate),
        LabelField.EXPIRY to formatLabelDate(effectiveExpiry),
        LabelField.QTY to input.itemCount.toString(),
        LabelField.OPERATOR to (input.operatorName ?: ""),
        LabelField.COUNTERPARTY_NAME to (input.counterpartyName ?: ""),
    )
}
```

- [ ] **Step 8: Write the fixture-driven test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/BoxLabelFixturesTest.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelField
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * The fixture is generated by `pnpm --filter @markiro/domain fixtures:box-labels`.
 * A disagreement here means this device would print a number or a date the rest
 * of the platform does not recognise.
 */
class BoxLabelFixturesTest {
    private val root = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResourceAsStream("box-label-fixtures.json"))
            .bufferedReader().readText(),
    ).jsonObject

    private val zone = ZoneId.of(root.getValue("timeZone").jsonPrimitive.content)

    @Test
    fun everySsccCaseAgreesWithTheDomain() {
        val cases = root.getValue("sscc").jsonArray
        assertTrue("fixtures are empty", cases.isNotEmpty())
        for (element in cases) {
            val case = element.jsonObject
            val digit = case.getValue("extensionDigit").jsonPrimitive.int
            val prefix = case.getValue("gs1Prefix").jsonPrimitive.content
            val serial = case.getValue("serial").jsonPrimitive.content.toLong()
            val expected = case.getValue("sscc").jsonPrimitive.let { if (it.isString) it.content else null }
            val label = "$digit/$prefix/$serial"
            if (expected != null) {
                assertEquals(label, expected, Sscc.build(digit, prefix, serial))
            } else {
                val thrown = runCatching { Sscc.build(digit, prefix, serial) }.exceptionOrNull()
                assertTrue("$label: expected a refusal", thrown is SsccException)
                assertEquals(label, case.getValue("error").jsonPrimitive.content, (thrown as SsccException).code)
            }
        }
    }

    @Test
    fun everyFieldCaseAgreesWithTheDomain() {
        val cases = root.getValue("fields").jsonArray
        assertTrue("fixtures are empty", cases.isNotEmpty())
        for (element in cases) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val input = case.getValue("input").jsonObject
            val actual = boxLabelFields(
                BoxLabelInput(
                    sscc = input.getValue("sscc").jsonPrimitive.content,
                    itemCount = input.getValue("itemCount").jsonPrimitive.int,
                    productName = input.getValue("productName").jsonPrimitive.content,
                    productPrintName = input.text("productPrintName"),
                    gtin14 = input.getValue("gtin14").jsonPrimitive.content,
                    egaisCode = input.text("egaisCode"),
                    shelfLifeDays = input.getValue("shelfLifeDays").jsonPrimitive.intOrNull,
                    operatorName = input.text("operatorName"),
                    counterpartyName = input.text("counterpartyName"),
                    closedAt = input.getValue("closedAt").jsonPrimitive.content,
                    productionDate = input.text("productionDate"),
                    shiftNumber = input.text("shiftNumber"),
                ),
                zone,
            )
            for ((field, expected) in case.getValue("fields").jsonObject) {
                assertEquals(
                    "$name / $field",
                    expected.jsonPrimitive.content,
                    actual.getValue(LabelField.fromWire(field)),
                )
            }
        }
    }

    /** A JSON null reads as a Kotlin null rather than the string "null". */
    private fun kotlinx.serialization.json.JsonObject.text(key: String): String? =
        getValue(key).jsonPrimitive.let { if (it.booleanOrNull == null && it.isString) it.content else null }
}
```

- [ ] **Step 9: Run the handheld gate**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL, both new tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/domain apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box apps/handheld/app/src/test
git commit -m "feat(handheld): SSCC and label dates, pinned by domain fixtures"
```

---

### Task 3: Room v5 — box rows, the SSCC pool and the columns they need

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/BoxEntities.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/BoxDaos.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftEntities.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceWipe.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt` (modify the existing file)

**Interfaces:**

- Produces: `BoxEntity`, `SsccRangeEntity`, `BoxDao`, `SsccPoolDao`, `MIGRATION_4_5`, and the new `ShiftEntity` fields `boxLabelTemplate`, `shelfLifeDays`, `egaisCode`, `ssccIssuerPrefix`

- [ ] **Step 1: Write the failing migration test**

Add to `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt`:

```kotlin
@Test
fun migration4to5AddsBoxesAndKeepsExistingRows() {
    // v4 with one shift and one accepted code, so the ALTERs are proven against
    // a database that actually has rows rather than a freshly created one.
    helper.createDatabase(TEST_DB, 4).use { db ->
        db.execSQL(
            "INSERT INTO shift_mirror (id, number, status, mode, productId, palletsEnabled, " +
                "validationPrintMode, listFetchedAt) VALUES ('s1','SEP26-001','open','aggregation','p1',0,'off',1)",
        )
        db.execSQL(
            "INSERT INTO codes_mirror (codeHash, shiftId, gtin14, serial, scannedAt) " +
                "VALUES ('h1','s1','04680089900000','abc','2026-09-10T08:00:00.000Z')",
        )
    }
    val db = helper.runMigrationsAndValidate(TEST_DB, 5, true, MIGRATION_4_5)
    db.query("SELECT boxId FROM codes_mirror WHERE codeHash = 'h1'").use { cursor ->
        assertTrue(cursor.moveToFirst())
        assertTrue(cursor.isNull(0))
    }
    db.query("SELECT COUNT(*) FROM boxes").use { cursor ->
        assertTrue(cursor.moveToFirst())
        assertEquals(0, cursor.getInt(0))
    }
    db.query("SELECT COUNT(*) FROM sscc_pool").use { cursor ->
        assertTrue(cursor.moveToFirst())
        assertEquals(0, cursor.getInt(0))
    }
}
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*MigrationTest*"
```

Expected: FAIL — `MIGRATION_4_5` is unresolved.

- [ ] **Step 3: Write the entities**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/BoxEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A transport box on this device.
 *
 * `boxId` is device-generated because the server identifies a closure by all
 * four of `(tenant, shiftId, terminalId, deviceBoxId)`. There is no
 * `itemCount` column: the count is always derived by counting `codes_mirror`
 * rows that name this box, so it can never disagree with them.
 *
 * `printState` is one of `pending`, `printing`, `printed`, `failed`,
 * `unknown`, `deferred`. A `printing` row found at startup is read as
 * `unknown` — the app died between handing bytes to the printer and hearing
 * back, which is exactly what "we do not know whether paper moved" means.
 */
@Entity(tableName = "boxes", indices = [Index(value = ["shiftId", "closedAt"])])
data class BoxEntity(
    @PrimaryKey val boxId: String,
    val shiftId: String,
    val sscc: String?,
    val openedAt: String,
    val closedAt: String?,
    val operatorId: String?,
    val printState: String,
    val printReason: String?,
    val ackedAt: String?,
)

/**
 * One block of SSCC serials the server granted this device, keyed by the
 * 9-digit GS1 issuer PREFIX rather than a GLN: one GS1 member commonly holds
 * several GLNs sharing one serial space, and keying by GLN would let a device
 * treat that single space as two independent ones. `extensionDigit` keeps box
 * ranges (0) and pallet ranges (1) from ever mixing.
 */
@Entity(tableName = "sscc_pool", primaryKeys = ["issuerPrefix", "extensionDigit", "fromSerial"])
data class SsccRangeEntity(
    val issuerPrefix: String,
    val extensionDigit: Int,
    val fromSerial: Long,
    val toSerial: Long,
    val nextSerial: Long,
)
```

- [ ] **Step 4: Add the columns to existing entities**

In `ShiftEntities.kt`, add to `CodeEntity` and `OutboxEntity`:

```kotlin
/** The transport box this code was scanned into, or null for an unboxed scan. */
val boxId: String? = null,
```

and to `ShiftEntity`:

```kotlin
/** The box label template's spec as the bundle delivered it; kept so a deferred label survives shift close. */
val boxLabelTemplate: String? = null,
val shelfLifeDays: Int? = null,
val egaisCode: String? = null,
/** The 9-digit issuer prefix this shift's SSCC block was cut from. */
val ssccIssuerPrefix: String? = null,
```

- [ ] **Step 5: Write the DAOs**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/BoxDaos.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface BoxDao {
    @Insert
    suspend fun insert(box: BoxEntity)

    @Query("SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    suspend fun open(shiftId: String): BoxEntity?

    @Query("SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    fun observeOpen(shiftId: String): Flow<BoxEntity?>

    @Query("SELECT * FROM boxes WHERE boxId = :boxId")
    suspend fun get(boxId: String): BoxEntity?

    /** Derived, never stored, and correlated by box rather than by shift. */
    @Query("SELECT COUNT(*) FROM codes_mirror WHERE boxId = :boxId")
    suspend fun itemCount(boxId: String): Int

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE boxId = :boxId")
    fun observeItemCount(boxId: String): Flow<Int>

    /** Display-only box number within the shift, derived so a restart cannot reset it. */
    @Query(
        "SELECT COUNT(*) FROM boxes WHERE shiftId = :shiftId AND (openedAt < :openedAt " +
            "OR (openedAt = :openedAt AND boxId <= :boxId))",
    )
    suspend fun ordinal(shiftId: String, openedAt: String, boxId: String): Int

    @Query(
        "UPDATE boxes SET sscc = :sscc, closedAt = :closedAt, operatorId = :operatorId, " +
            "printState = 'pending', printReason = NULL WHERE boxId = :boxId AND closedAt IS NULL",
    )
    suspend fun close(boxId: String, sscc: String, closedAt: String, operatorId: String?): Int

    @Query("UPDATE boxes SET printState = :state, printReason = :reason WHERE boxId = :boxId")
    suspend fun setPrintState(boxId: String, state: String, reason: String?)

    /** Anything the app left mid-print is unknown, not resumable. */
    @Query("UPDATE boxes SET printState = 'unknown', printReason = NULL WHERE printState = 'printing'")
    suspend fun demoteInterruptedPrints(): Int

    /** The deferred-label queue: closed boxes whose label is not resolved, oldest first. */
    @Query("SELECT * FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed' ORDER BY closedAt")
    fun observeUnprinted(): Flow<List<BoxEntity>>

    @Query("SELECT COUNT(*) FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed'")
    fun observeUnprintedCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM boxes WHERE shiftId = :shiftId AND closedAt IS NOT NULL")
    suspend fun closedCount(shiftId: String): Int

    /** Closed and unacknowledged, oldest first, for the sync batch. */
    @Query("SELECT * FROM boxes WHERE closedAt IS NOT NULL AND ackedAt IS NULL ORDER BY closedAt, boxId LIMIT :limit")
    suspend fun unacked(limit: Int): List<BoxEntity>

    @Query("UPDATE boxes SET ackedAt = :at WHERE boxId IN (:boxIds)")
    suspend fun markAcked(boxIds: List<String>, at: String)

    @Query("DELETE FROM boxes")
    suspend fun clear()
}

@Dao
interface SsccPoolDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(range: SsccRangeEntity): Long

    /**
     * Never regresses an already-advanced cursor, and advances one that is
     * behind what the server knows was consumed — which is what repairs a
     * device restored from a stale copy before it reissues printed serials.
     */
    @Query(
        "UPDATE sscc_pool SET nextSerial = MAX(nextSerial, :nextSerial) " +
            "WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit AND fromSerial = :fromSerial",
    )
    suspend fun advance(issuerPrefix: String, extensionDigit: Int, fromSerial: Long, nextSerial: Long)

    @Query(
        "SELECT * FROM sscc_pool WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit " +
            "AND nextSerial <= toSerial ORDER BY fromSerial LIMIT 1",
    )
    suspend fun lowestWithRoom(issuerPrefix: String, extensionDigit: Int): SsccRangeEntity?

    @Query(
        "UPDATE sscc_pool SET nextSerial = :nextSerial WHERE issuerPrefix = :issuerPrefix " +
            "AND extensionDigit = :extensionDigit AND fromSerial = :fromSerial",
    )
    suspend fun setCursor(issuerPrefix: String, extensionDigit: Int, fromSerial: Long, nextSerial: Long)

    @Query(
        "DELETE FROM sscc_pool WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit " +
            "AND fromSerial IN (:fromSerials)",
    )
    suspend fun drop(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>)

    @Query(
        "SELECT COALESCE(SUM(toSerial - nextSerial + 1), 0) FROM sscc_pool WHERE issuerPrefix = :issuerPrefix " +
            "AND extensionDigit = :extensionDigit AND nextSerial <= toSerial",
    )
    suspend fun remaining(issuerPrefix: String, extensionDigit: Int): Long

    @Query("DELETE FROM sscc_pool")
    suspend fun clear()
}
```

- [ ] **Step 6: Write the migration**

Append to `Migrations.kt`:

```kotlin
val MIGRATION_4_5 = object : Migration(4, 5) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `boxes` (`boxId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `sscc` TEXT, " +
                "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, " +
                "`printReason` TEXT, `ackedAt` TEXT, PRIMARY KEY(`boxId`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_boxes_shiftId_closedAt` ON `boxes` (`shiftId`, `closedAt`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `sscc_pool` (`issuerPrefix` TEXT NOT NULL, `extensionDigit` INTEGER NOT NULL, " +
                "`fromSerial` INTEGER NOT NULL, `toSerial` INTEGER NOT NULL, `nextSerial` INTEGER NOT NULL, " +
                "PRIMARY KEY(`issuerPrefix`, `extensionDigit`, `fromSerial`))",
        )
        db.execSQL("ALTER TABLE `codes_mirror` ADD COLUMN `boxId` TEXT")
        db.execSQL("ALTER TABLE `outbox` ADD COLUMN `boxId` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `boxLabelTemplate` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `shelfLifeDays` INTEGER")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `egaisCode` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `ssccIssuerPrefix` TEXT")
    }
}
```

- [ ] **Step 7: Register everything**

In `HandheldDatabase.kt`, add `BoxEntity::class` and `SsccRangeEntity::class` to `entities`, bump `version = 5`, and add:

```kotlin
abstract fun boxDao(): BoxDao
abstract fun ssccPoolDao(): SsccPoolDao
```

In `StorageModule.kt`, add `MIGRATION_4_5` to the `addMigrations(...)` call. In `DeviceWipe.kt`, add `db.boxDao().clear()` and `db.ssccPoolDao().clear()` alongside the existing clears.

- [ ] **Step 8: Run the gate**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL; the migration test passes.

- [ ] **Step 9: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): Room v5 with boxes and the SSCC pool"
```

---

### Task 4: The SSCC pool

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/SsccPool.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/SsccPoolTest.kt`

**Interfaces:**

- Consumes: `SsccPoolDao`, `SsccRangeEntity`, `HandheldDatabase` from Task 3
- Produces: `SsccPool(db)` with `suspend fun addRange(range: ServerRange)`, `suspend fun dropRanges(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>)`, `suspend fun burn(issuerPrefix: String, extensionDigit: Int): Long?`, `suspend fun remaining(issuerPrefix: String, extensionDigit: Int): Long`, and `data class ServerRange(issuerPrefix: String, extensionDigit: Int, fromSerial: Long, toSerial: Long, consumedThroughSerial: Long?)`

- [ ] **Step 1: Write the failing tests**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/SsccPoolTest.kt`:

```kotlin
package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SsccPoolTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
    }

    @After
    fun tearDown() = db.close()

    private fun range(from: Long, to: Long, consumed: Long? = null) =
        ServerRange("468008990", 0, from, to, consumed)

    @Test
    fun serialsComeOutInOrderAndTheCursorSurvives() = runTest {
        pool.addRange(range(100, 102))
        assertEquals(100L, pool.burn("468008990", 0))
        assertEquals(101L, pool.burn("468008990", 0))
        assertEquals(1L, pool.remaining("468008990", 0))
    }

    @Test
    fun aDryPoolReturnsNullRatherThanReissuing() = runTest {
        pool.addRange(range(1, 1))
        assertEquals(1L, pool.burn("468008990", 0))
        assertNull(pool.burn("468008990", 0))
    }

    @Test
    fun replayingABlockNeverRegressesTheCursor() = runTest {
        // The server always reports ORIGINAL bounds. Re-applying them must not
        // hand back serials that are already on printed labels.
        pool.addRange(range(100, 200))
        pool.burn("468008990", 0)
        pool.burn("468008990", 0)
        pool.addRange(range(100, 200))
        assertEquals(102L, pool.burn("468008990", 0))
    }

    @Test
    fun aBlockIsAdvancedToWhatTheServerKnowsWasConsumed() = runTest {
        // A device restored from a stale copy holds a cursor behind the server's.
        pool.addRange(range(100, 200))
        pool.addRange(range(100, 200, consumed = 150))
        assertEquals(151L, pool.burn("468008990", 0))
    }

    @Test
    fun revokedRangesAreDeletedSoTheReplacementWins() = runTest {
        // Burning picks the lowest fromSerial with room, so a revoked low range
        // left in place would keep winning over the reseeded one.
        pool.addRange(range(100, 200))
        pool.addRange(range(500, 600))
        pool.dropRanges("468008990", 0, listOf(100))
        assertEquals(500L, pool.burn("468008990", 0))
    }

    @Test
    fun extensionDigitsNeverShareASerialSpace() = runTest {
        pool.addRange(range(10, 20))
        pool.addRange(ServerRange("468008990", 1, 10, 20, null))
        assertEquals(10L, pool.burn("468008990", 0))
        assertEquals(10L, pool.burn("468008990", 1))
    }

    @Test
    fun concurrentBurnsNeverIssueOneSerialTwice() = runTest {
        // Two boxes sharing one SSCC is the single failure the server cannot
        // repair, so this is the test the whole locking design exists for.
        pool.addRange(range(0, 199))
        val burned = List(200) { async { pool.burn("468008990", 0) } }.awaitAll()
        assertEquals(200, burned.filterNotNull().toSet().size)
    }
}
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*SsccPoolTest*"
```

Expected: FAIL — `SsccPool` is unresolved.

- [ ] **Step 3: Write the pool**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/SsccPool.kt`:

```kotlin
package app.markiro.handheld.core.box

import androidx.room.withTransaction
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.SsccRangeEntity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * A block exactly as the server describes it in the shift bundle.
 *
 * `fromSerial`/`toSerial` are the block's ORIGINAL bounds even on a repeat
 * fetch — never the unconsumed remainder — and `consumedThroughSerial` is the
 * highest serial the server has recorded as used, or null before any is.
 */
data class ServerRange(
    val issuerPrefix: String,
    val extensionDigit: Int,
    val fromSerial: Long,
    val toSerial: Long,
    val consumedThroughSerial: Long?,
)

/**
 * This device's own serial ranges.
 *
 * Port of `apps/station/src/lib/sscc-pool.ts` with one deliberate difference.
 * The station burns in a single `UPDATE ... RETURNING`, because
 * `tauri-plugin-sql` hands each call whatever pooled connection is free, so a
 * SELECT followed by an UPDATE can give one serial to two callers. Room gives
 * a real transaction and `minSdk = 28` means SQLite 3.22, which has no
 * `RETURNING` at all, so the same guarantee is a mutex around a transaction.
 * The rule is unchanged: two boxes must never share an SSCC.
 */
class SsccPool(private val db: HandheldDatabase) {
    private val mutex = Mutex()

    /**
     * Idempotent and progress-preserving. The primary key turns a replay of a
     * block already held into an update of that same row, and `MAX` makes the
     * update safe in both directions: it never regresses a cursor that has
     * advanced locally, and it advances one that is behind what the server
     * knows was consumed — which is what stops a device restored from a stale
     * copy from reissuing serials that are already on printed labels.
     */
    suspend fun addRange(range: ServerRange) = mutex.withLock {
        val dao = db.ssccPoolDao()
        val seeded = range.consumedThroughSerial?.plus(1) ?: range.fromSerial
        db.withTransaction {
            dao.insertIgnore(
                SsccRangeEntity(
                    issuerPrefix = range.issuerPrefix,
                    extensionDigit = range.extensionDigit,
                    fromSerial = range.fromSerial,
                    toSerial = range.toSerial,
                    nextSerial = seeded,
                ),
            )
            dao.advance(range.issuerPrefix, range.extensionDigit, range.fromSerial, seeded)
        }
    }

    /**
     * Deletes revoked blocks rather than exhausting them: `burn` picks the
     * lowest `fromSerial` with room, so a revoked block left in place keeps
     * winning over the replacement an admin just cut, and the reseeded number
     * would never reach a label.
     */
    suspend fun dropRanges(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>) {
        if (fromSerials.isEmpty()) return
        mutex.withLock { db.ssccPoolDao().drop(issuerPrefix, extensionDigit, fromSerials) }
    }

    /** The lowest unspent serial, or null when the pool is dry. */
    suspend fun burn(issuerPrefix: String, extensionDigit: Int): Long? = mutex.withLock {
        val dao = db.ssccPoolDao()
        db.withTransaction {
            val range = dao.lowestWithRoom(issuerPrefix, extensionDigit) ?: return@withTransaction null
            dao.setCursor(issuerPrefix, extensionDigit, range.fromSerial, range.nextSerial + 1)
            range.nextSerial
        }
    }

    suspend fun remaining(issuerPrefix: String, extensionDigit: Int): Long =
        db.ssccPoolDao().remaining(issuerPrefix, extensionDigit)

    companion object {
        /** Boxes. Pallets use 1, and the two must never mix in one range. */
        const val BOX_EXTENSION_DIGIT = 0
    }
}
```

- [ ] **Step 4: Run to see it pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*SsccPoolTest*"
```

Expected: all seven tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): the device's SSCC pool"
```

---

### Task 5: Read the bundle's SSCC block and box template, and stop refusing aggregation shifts

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/ShiftDtos.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt` (modify)

**Interfaces:**

- Consumes: `SsccPool`, `ServerRange` from Task 4
- Produces: `ShiftEntity.boxLabelTemplate`/`shelfLifeDays`/`egaisCode`/`ssccIssuerPrefix` populated on entry; `EnterResult.AggregationUnsupported` removed

- [ ] **Step 1: Write the failing test**

Add to `ShiftRepositoryTest.kt`:

```kotlin
@Test
fun enteringAnAggregationShiftStoresItsBlockAndTemplate() = runTest {
    server.enqueue(MockResponse().setBody("{}"))            // POST enter
    server.enqueue(MockResponse().setBody(AGGREGATION_BUNDLE))
    assertEquals(EnterResult.Ok, repository.enter("s1"))
    val shift = db.shiftDao().get("s1")!!
    assertEquals("468008990", shift.ssccIssuerPrefix)
    assertEquals(365, shift.shelfLifeDays)
    assertTrue(shift.boxLabelTemplate!!.contains("\"widthMm\""))
    // The block is in the pool at its ORIGINAL bounds, advanced past what the
    // server already recorded as consumed.
    assertEquals(101L, SsccPool(db).burn("468008990", 0))
}

@Test
fun aRevokedBlockIsDroppedBeforeTheNewOneIsApplied() = runTest {
    val pool = SsccPool(db)
    pool.addRange(ServerRange("468008990", 0, 1, 50, null))
    server.enqueue(MockResponse().setBody("{}"))
    server.enqueue(MockResponse().setBody(AGGREGATION_BUNDLE))
    repository.enter("s1")
    // The revoked low range would otherwise keep winning over the new one.
    assertEquals(101L, pool.burn("468008990", 0))
}
```

with, at the bottom of the file:

```kotlin
private const val AGGREGATION_BUNDLE = """
{
  "shift": {"id":"s1","number":"SEP26-001","status":"open","mode":"aggregation","productId":"p1",
            "productName":"Вода","palletsEnabled":false,"boxCapacity":20,
            "validationPrint":{"mode":"off"}},
  "product": {"id":"p1","gtin14":"04680089900000","name":"Вода","shelfLifeDays":365},
  "boxLabelTemplate": {"id":"t1","name":"Коробка 58×40",
    "spec":{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}},
  "sscc": {"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":1,"toSerial":1000,
           "consumedThroughSerial":100},
  "ssccRevokedFrom": [1],
  "operators": []
}
"""
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*ShiftRepositoryTest*"
```

Expected: FAIL — the shift is refused with `AggregationUnsupported`.

- [ ] **Step 3: Extend the DTOs**

In `ShiftDtos.kt`:

```kotlin
@Serializable
data class BundleProductDto(
    val id: String,
    val gtin14: String,
    val name: String,
    val printName: String? = null,
    val shelfLifeDays: Int? = null,
    val egaisCode: String? = null,
)

@Serializable
data class BundleSsccDto(
    val issuerPrefix: String,
    val extensionDigit: Int,
    val fromSerial: Long,
    val toSerial: Long,
    val consumedThroughSerial: Long? = null,
)

@Serializable
data class BundleBoxTemplateDto(val id: String, val name: String, val spec: JsonElement)

@Serializable
data class ShiftBundleDto(
    val shift: ShiftDto,
    val product: BundleProductDto,
    val operators: List<OperatorDto> = emptyList(),
    val boxLabelTemplate: BundleBoxTemplateDto? = null,
    val sscc: BundleSsccDto? = null,
    /** `fromSerial` of every block an admin has revoked since it was granted. */
    val ssccRevokedFrom: List<Long> = emptyList(),
)
```

- [ ] **Step 4: Apply the bundle in the repository**

In `ShiftRepository.kt`, delete the line

```kotlin
if ((cached?.mode ?: fallback?.mode) == "aggregation") return EnterResult.AggregationUnsupported
```

and remove `AggregationUnsupported` from `EnterResult` plus its now-dead branch in `ShiftListViewModel.kt:174`. Where the bundle is applied, add:

```kotlin
// Revoked blocks are dropped BEFORE the new one is applied: burning picks the
// lowest fromSerial with room, so a revoked range left in place would keep
// winning over the replacement the admin just cut.
bundle.sscc?.let { block ->
    pool.dropRanges(block.issuerPrefix, block.extensionDigit, bundle.ssccRevokedFrom)
    pool.addRange(
        ServerRange(
            issuerPrefix = block.issuerPrefix,
            extensionDigit = block.extensionDigit,
            fromSerial = block.fromSerial,
            toSerial = block.toSerial,
            consumedThroughSerial = block.consumedThroughSerial,
        ),
    )
}
```

and extend the shift row write with:

```kotlin
boxLabelTemplate = bundle.boxLabelTemplate?.spec?.toString(),
shelfLifeDays = bundle.product.shelfLifeDays,
egaisCode = bundle.product.egaisCode,
ssccIssuerPrefix = bundle.sscc?.issuerPrefix,
```

`SsccPool` is constructor-injected into `ShiftRepository`; add it to the Hilt provider in `ShiftModule.kt`.

- [ ] **Step 5: Run the gate**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): accept aggregation shifts and their SSCC block"
```

---

### Task 6: The box repository and the close pipeline

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxRepository.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/CloseBox.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/CloseBoxTest.kt`

**Interfaces:**

- Consumes: `SsccPool`, `Sscc`, `BoxDao` from Tasks 2–4
- Produces: `BoxRepository(db)` with `suspend fun currentBox(shiftId: String): BoxEntity`, `suspend fun ordinal(box: BoxEntity): Int`, `suspend fun itemCount(boxId: String): Int`; `CloseBox(db, pool, clock)` with `suspend fun close(shiftId: String, issuerPrefix: String?, operatorId: String?): CloseResult`; `sealed interface CloseResult { data class Closed(box, sscc, itemCount, closedAt); data object Empty; data object NoSerials; data object InvalidSerial; data object NoIssuer }`

- [ ] **Step 1: Write the failing tests**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/CloseBoxTest.kt`:

```kotlin
package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseBoxTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool
    private lateinit var boxes: BoxRepository
    private lateinit var closer: CloseBox

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
        boxes = BoxRepository(db)
        closer = CloseBox(db, boxes, pool) { 1_757_000_000_000L }
    }

    @After
    fun tearDown() = db.close()

    private suspend fun scanInto(boxId: String, hash: String) = db.codeDao().insert(
        CodeEntity(hash, "s1", "04680089900000", hash, "2026-09-10T08:00:00.000Z", boxId),
    )

    @Test
    fun anEmptyBoxCostsNoSerial() = runTest {
        pool.addRange(ServerRange("468008990", 0, 1, 10, null))
        boxes.currentBox("s1")
        assertEquals(CloseResult.Empty, closer.close("s1", "468008990", null))
        // The serial must still be there: an operator closing an empty box by
        // mistake is routine, and it must not consume a number.
        assertEquals(10L, pool.remaining("468008990", 0))
    }

    @Test
    fun aFilledBoxClosesWithAnSsccAndItsOwnTimestamp() = runTest {
        pool.addRange(ServerRange("468008990", 0, 1, 10, null))
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        scanInto(box.boxId, "h2")
        val result = closer.close("s1", "468008990", "op1") as CloseResult.Closed
        assertEquals(2, result.itemCount)
        assertEquals(Sscc.build(0, "468008990", 1), result.sscc)
        val stored = db.boxDao().get(box.boxId)!!
        assertEquals(result.sscc, stored.sscc)
        assertEquals(result.closedAt, stored.closedAt)
        assertEquals("pending", stored.printState)
        // The next scan opens a NEW box rather than joining the closed one.
        assertTrue(boxes.currentBox("s1").boxId != box.boxId)
    }

    @Test
    fun aDryPoolLeavesTheBoxOpen() = runTest {
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.NoSerials, closer.close("s1", "468008990", null))
        assertNull(db.boxDao().get(box.boxId)!!.closedAt)
    }

    @Test
    fun aSerialBeyondThePrefixLeavesTheBoxOpen() = runTest {
        // A local range reaching past the issuer prefix's own capacity. The
        // serial is burned and cannot be given back, but the box must stay
        // closable rather than being left half-closed.
        pool.addRange(ServerRange("468008990", 0, 10_000_000, 10_000_001, null))
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.InvalidSerial, closer.close("s1", "468008990", null))
        assertNull(db.boxDao().get(box.boxId)!!.closedAt)
    }

    @Test
    fun aShiftWithNoIssuerCannotCloseABox() = runTest {
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.NoIssuer, closer.close("s1", null, null))
    }

    @Test
    fun boxNumbersAreStableAcrossRestarts() = runTest {
        pool.addRange(ServerRange("468008990", 0, 1, 10, null))
        val first = boxes.currentBox("s1")
        scanInto(first.boxId, "h1")
        closer.close("s1", "468008990", null)
        val second = boxes.currentBox("s1")
        assertEquals(1, boxes.ordinal(first))
        assertEquals(2, boxes.ordinal(second))
    }
}
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*CloseBoxTest*"
```

Expected: FAIL — `BoxRepository` and `CloseBox` are unresolved.

- [ ] **Step 3: Write the repository**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxRepository.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** The device's boxes. One box is open per shift at a time. */
class BoxRepository(
    private val db: HandheldDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    /** The shift's open box, opening one if none is. */
    suspend fun currentBox(shiftId: String): BoxEntity = mutex.withLock {
        db.boxDao().open(shiftId) ?: BoxEntity(
            boxId = UUID.randomUUID().toString(),
            shiftId = shiftId,
            sscc = null,
            openedAt = Iso.format(clock()),
            closedAt = null,
            operatorId = null,
            printState = "pending",
            printReason = null,
            ackedAt = null,
        ).also { db.boxDao().insert(it) }
    }

    fun observeOpen(shiftId: String): Flow<BoxEntity?> = db.boxDao().observeOpen(shiftId)

    suspend fun itemCount(boxId: String): Int = db.boxDao().itemCount(boxId)

    fun observeItemCount(boxId: String): Flow<Int> = db.boxDao().observeItemCount(boxId)

    /**
     * The box's display number within its shift. Derived from persisted rows
     * rather than counted in memory, so a restart cannot reset the floor aid —
     * and deliberately unrelated to the SSCC, so it costs no serial.
     */
    suspend fun ordinal(box: BoxEntity): Int = db.boxDao().ordinal(box.shiftId, box.openedAt, box.boxId)

    fun observeUnprinted(): Flow<List<BoxEntity>> = db.boxDao().observeUnprinted()

    fun observeUnprintedCount(): Flow<Int> = db.boxDao().observeUnprintedCount()

    suspend fun setPrintState(boxId: String, state: String, reason: String?) =
        db.boxDao().setPrintState(boxId, state, reason)

    /** Called once at startup: anything left mid-print is unknown, never resumed. */
    suspend fun demoteInterruptedPrints(): Int = db.boxDao().demoteInterruptedPrints()
}
```

- [ ] **Step 4: Write the close pipeline**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/CloseBox.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso

sealed interface CloseResult {
    data class Closed(val box: BoxEntity, val sscc: String, val itemCount: Int, val closedAt: String) : CloseResult

    /** No box is open, or the open one has nothing in it. Nothing was burned. */
    data object Empty : CloseResult

    /** This issuer prefix's pool is dry. Nothing was burned; the box stays open. */
    data object NoSerials : CloseResult

    /**
     * The burned serial cannot become a valid SSCC. Only reachable when this
     * device holds a range beyond its issuer prefix's capacity — a corrupted
     * local pool. The serial is already burned and cannot be given back, the
     * same way an abandoned box costs one; the box is left OPEN so the operator
     * can simply try again rather than being stranded half-closed.
     */
    data object InvalidSerial : CloseResult

    /** The shift carries no SSCC issuer, so no box of it can ever be numbered. */
    data object NoIssuer : CloseResult
}

/**
 * Closes the shift's open box.
 *
 * The order of the checks is the design. Emptiness is tested BEFORE burning, so
 * a box closed by mistake costs no serial, and the serial is burned only once
 * the pool actually yields one — never pre-emptively. That is why a serial is
 * burned here, at close, and not when the box was opened: a box abandoned at
 * shift end then costs nothing either.
 */
class CloseBox(
    private val db: HandheldDatabase,
    private val boxes: BoxRepository,
    private val pool: SsccPool,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun close(shiftId: String, issuerPrefix: String?, operatorId: String?): CloseResult {
        if (issuerPrefix == null) return CloseResult.NoIssuer
        val box = db.boxDao().open(shiftId) ?: return CloseResult.Empty
        val itemCount = boxes.itemCount(box.boxId)
        if (itemCount == 0) return CloseResult.Empty

        val serial = pool.burn(issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT) ?: return CloseResult.NoSerials
        val sscc = try {
            Sscc.build(SsccPool.BOX_EXTENSION_DIGIT, issuerPrefix, serial)
        } catch (_: SsccException) {
            return CloseResult.InvalidSerial
        }

        val closedAt = Iso.format(clock())
        if (db.boxDao().close(box.boxId, sscc, closedAt, operatorId) == 0) return CloseResult.Empty
        return CloseResult.Closed(
            box = box.copy(sscc = sscc, closedAt = closedAt, operatorId = operatorId, printState = "pending"),
            sscc = sscc,
            itemCount = itemCount,
            closedAt = closedAt,
        )
    }
}
```

- [ ] **Step 5: Run to see it pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*CloseBoxTest*"
```

Expected: all six tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): box rows and the close pipeline"
```

---

### Task 7: Scanning into a box

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/scan/ScanRecorder.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/scan/ScanRecorderTest.kt` (modify)

**Interfaces:**

- Consumes: `BoxRepository.currentBox` from Task 6
- Produces: `ScanRecorder.record(shift, raw, operatorId, boxId: String?)` writing `boxId` onto the code row and the outbox row

- [ ] **Step 1: Write the failing test**

Add to `ScanRecorderTest.kt`:

```kotlin
@Test
fun anAcceptedScanCarriesItsBoxIntoTheCodeRowAndTheOutbox() = runTest {
    val outcome = recorder.record(aggregationShift, VALID_KM, "op1", boxId = "box-1")
    assertEquals(Verdict.OK, outcome.verdict)
    assertEquals("box-1", db.codeDao().get(outcome.hash!!)!!.boxId)
    assertEquals("box-1", db.outboxDao().head(1).single().boxId)
}

@Test
fun aRejectedScanNeverJoinsABox() = runTest {
    // The server refuses a boxId without an accepted code, and it is right to:
    // a box counts what it actually holds.
    recorder.record(aggregationShift, "not-a-code", "op1", boxId = "box-1")
    assertNull(db.outboxDao().head(1).single().boxId)
}
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*ScanRecorderTest*"
```

Expected: FAIL — `record` has no `boxId` parameter.

- [ ] **Step 3: Thread the box id through**

In `ScanRecorder.kt`, change the signature to

```kotlin
suspend fun record(
    shift: ShiftEntity,
    raw: String,
    operatorId: String?,
    boxId: String? = null,
): ScanOutcome = mutex.withLock {
```

and in the private `write(...)` helper add a `boxId: String?` parameter, passing it to `CodeEntity` and `OutboxEntity`. Pass `boxId` only on the accepted branch:

```kotlin
// A box counts what it actually holds. The server rejects a boxId without an
// accepted code, so a rejected scan carries none.
write(shift.id, raw, verdict, scannedAt, operatorId, hash, km, if (verdict == Verdict.OK) boxId else null)
```

- [ ] **Step 4: Run to see it pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*ScanRecorderTest*"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): carry the box through a scan"
```

---

### Task 8: Rendering and printing the box label

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxPrinter.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxModule.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/BoxPrinterTest.kt`

**Interfaces:**

- Consumes: `LabelRenderer.render(spec, data, language, dpi): ByteArray` and `PrinterTransport.status`/`send` from #491; `boxLabelFields` from Task 2; `BoxRepository.setPrintState` from Task 6
- Produces: `BoxPrinter(db, boxes, renderer, transport)` with `suspend fun print(boxId: String): PrintOutcome`; `sealed interface PrintOutcome { data object Printed; data class Failed(reason: String); data class Unknown(cause: String) }`

- [ ] **Step 1: Write the failing tests**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box/BoxPrinterTest.kt`:

```kotlin
package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoxPrinterTest {
    private lateinit var db: HandheldDatabase

    private class FakeTransport(
        var nextStatus: PrinterStatus = PrinterStatus.Ready,
        var outcome: SendOutcome = SendOutcome.Delivered,
    ) : PrinterTransport {
        var sent: ByteArray? = null
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent = document
            return outcome
        }
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun printer(transport: FakeTransport) = BoxPrinter(
        db,
        BoxRepository(db),
        LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }),
        transport,
    )

    @Test
    fun aClosedBoxPrintsItsOwnSsccAndDates() = runTest {
        val transport = FakeTransport()
        seedClosedBox(sscc = "046800899000000018", closedAt = "2026-09-10T08:00:00.000Z")
        assertEquals(PrintOutcome.Printed, printer(transport).print("box-1"))
        val document = transport.sent!!.toString(Charsets.ISO_8859_1)
        // The bare 18 digits reach the emitter; the (00) identifier is added there.
        assertTrue(document.contains("046800899000000018"))
        assertEquals("printed", db.boxDao().get("box-1")!!.printState)
    }

    @Test
    fun aShiftWithNoTemplateFailsByNameWithoutSending() = runTest {
        val transport = FakeTransport()
        seedClosedBox(template = null)
        assertEquals(PrintOutcome.Failed("template_missing"), printer(transport).print("box-1"))
        assertEquals(null, transport.sent)
    }

    @Test
    fun noPrinterConfiguredIsItsOwnReason() = runTest {
        val transport = FakeTransport()
        seedClosedBox(withPrinter = false)
        assertEquals(PrintOutcome.Failed("printer_unconfigured"), printer(transport).print("box-1"))
    }

    @Test
    fun aPrinterOutOfPaperRefusesBeforeAnythingIsSent() = runTest {
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        seedClosedBox()
        assertEquals(PrintOutcome.Failed("no_paper"), printer(transport).print("box-1"))
        assertEquals(null, transport.sent)
    }

    @Test
    fun aLinkThatBreaksPartwayLeavesTheBoxUnknown() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        seedClosedBox()
        assertTrue(printer(transport).print("box-1") is PrintOutcome.Unknown)
        assertEquals("unknown", db.boxDao().get("box-1")!!.printState)
    }

    @Test
    fun aPrintInterruptedByTheAppDyingIsUnknownNotResumed() = runTest {
        seedClosedBox()
        db.boxDao().setPrintState("box-1", "printing", null)
        BoxRepository(db).demoteInterruptedPrints()
        // Resuming would be an automatic resend, which is the one thing an
        // unknown outcome must never do.
        assertEquals("unknown", db.boxDao().get("box-1")!!.printState)
    }
}
```

`seedClosedBox(...)` is a private helper in the same file that inserts a shift row (with `boxLabelTemplate`, `shelfLifeDays`, `productName`, `productGtin14`, `number`), a selected `PrinterEntity` unless `withPrinter = false`, a closed `BoxEntity`, and one `CodeEntity` naming it.

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*BoxPrinterTest*"
```

Expected: FAIL — `BoxPrinter` is unresolved.

- [ ] **Step 3: Write the printer**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxPrinter.kt`:

```kotlin
package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.LabelSpecCodec
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase

sealed interface PrintOutcome {
    data object Printed : PrintOutcome

    /** Nothing was printed and we know it. The reason is the operator's next step. */
    data class Failed(val reason: String) : PrintOutcome

    /** The bytes may or may not have reached the printer. Nothing resends from here on its own. */
    data class Unknown(val cause: String) : PrintOutcome
}

/**
 * Renders a closed box's label and sends it.
 *
 * The label is re-rendered on every attempt rather than stored as bytes,
 * because «Другой принтер» may speak a different language at a different
 * resolution — and because the box row already holds everything the render
 * needs. `closedAt` comes off that row too, never from the clock: two labels
 * for one SSCC must not disagree about «Дата производства» and «Годен до».
 */
class BoxPrinter(
    private val db: HandheldDatabase,
    private val boxes: BoxRepository,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
) {
    suspend fun print(boxId: String): PrintOutcome {
        val box = db.boxDao().get(boxId) ?: return fail(boxId, "box_missing")
        val closedAt = box.closedAt ?: return fail(boxId, "box_open")
        val sscc = box.sscc ?: return fail(boxId, "box_open")
        val shift = db.shiftDao().get(box.shiftId) ?: return fail(boxId, "shift_missing")
        val templateJson = shift.boxLabelTemplate ?: return fail(boxId, "template_missing")
        val printer = db.printerDao().selected() ?: return fail(boxId, "printer_unconfigured")

        val spec = try {
            LabelSpecCodec.parse(templateJson)
        } catch (_: LabelRenderException) {
            return fail(boxId, "template_invalid")
        }

        // Asked before sending, so a refusal can carry the printer's own reason
        // rather than a generic timeout. This is the only way «Нет бумаги» can
        // exist as a state at all.
        when (val status = transport.status(printer)) {
            is PrinterStatus.NotReady -> return fail(boxId, status.reason.wire())
            PrinterStatus.Ready -> Unit
        }

        val fields = boxLabelFields(
            BoxLabelInput(
                sscc = sscc,
                itemCount = boxes.itemCount(boxId),
                productName = shift.productName.orEmpty(),
                productPrintName = shift.productPrintName,
                gtin14 = shift.productGtin14.orEmpty(),
                egaisCode = shift.egaisCode,
                shelfLifeDays = shift.shelfLifeDays,
                operatorName = null,
                counterpartyName = shift.counterpartyName,
                closedAt = closedAt,
                productionDate = shift.productionDate,
                shiftNumber = shift.number,
            ),
        )

        boxes.setPrintState(boxId, "printing", null)
        val document = try {
            renderer.render(spec, fields, PrinterLanguage.fromWire(printer.language), printer.dpi)
        } catch (_: LabelRenderException) {
            return fail(boxId, "render_failed")
        }

        return when (val outcome = transport.send(printer, document)) {
            SendOutcome.Delivered -> {
                boxes.setPrintState(boxId, "printed", null)
                PrintOutcome.Printed
            }
            is SendOutcome.Refused -> fail(boxId, outcome.reason.wire())
            is SendOutcome.Unknown -> {
                boxes.setPrintState(boxId, "unknown", outcome.cause)
                PrintOutcome.Unknown(outcome.cause)
            }
        }
    }

    private suspend fun fail(boxId: String, reason: String): PrintOutcome.Failed {
        boxes.setPrintState(boxId, "failed", reason)
        return PrintOutcome.Failed(reason)
    }

    private fun NotReadyReason.wire() = when (this) {
        NotReadyReason.NO_PAPER -> "no_paper"
        NotReadyReason.HEAD_OPEN -> "head_open"
        NotReadyReason.UNREACHABLE -> "unreachable"
        NotReadyReason.OTHER -> "transport_failed"
    }
}
```

Create `BoxModule.kt` providing `SsccPool`, `BoxRepository`, `CloseBox` and `BoxPrinter` as `@Singleton`s, following the shape of `PrintModule.kt`.

- [ ] **Step 4: Run to see it pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*BoxPrinterTest*"
```

Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): render and print the box label"
```

---

### Task 9: Carry box closures in the sync batch

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/sync/SyncDtos.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/sync/SyncEngineTest.kt` (modify)

**Interfaces:**

- Consumes: `BoxDao.unacked`/`markAcked` from Task 3
- Produces: `SyncBatchRequest(batchId, items, boxes)` and `BoxClosureDto`; `MetaStore.SYNC_PENDING_BOX_COUNT`

- [ ] **Step 1: Write the failing tests**

Add to `SyncEngineTest.kt`:

```kotlin
@Test
fun aClosedBoxTravelsWithTheBatchAndIsAcknowledged() = runTest {
    seedScan()
    seedClosedBox("box-1", "046800899000000018")
    server.enqueue(MockResponse().setBody("""{"applied":1,"alreadyApplied":false,"conflicts":[]}"""))
    assertTrue(engine.drainAll())
    val body = json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
    val box = body.getValue("boxes").jsonArray.single().jsonObject
    assertEquals("046800899000000018", box.getValue("sscc").jsonPrimitive.content)
    // Print verification is not in this slice, and the server defaults both to null.
    assertTrue(box["printVerifiedAt"] == null || box.getValue("printVerifiedAt") is JsonNull)
    assertNotNull(db.boxDao().get("box-1")!!.ackedAt)
}

@Test
fun aBoxThatClosesWhileABatchIsInFlightIsNotLost() = runTest {
    // The defect this test exists for: keying batchId off the item ceiling
    // alone means a retry sends the same id with a different body, the server
    // answers alreadyApplied, and the closure disappears silently.
    seedScan()
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    assertFalse(engine.drainAll())
    val firstId = batchIdOf(server.takeRequest())

    seedClosedBox("box-1", "046800899000000018")
    server.enqueue(MockResponse().setBody("""{"applied":1,"alreadyApplied":false,"conflicts":[]}"""))
    assertTrue(engine.drainAll())
    val retry = server.takeRequest()
    assertNotEquals(firstId, batchIdOf(retry))
    assertEquals(1, json.parseToJsonElement(retry.body.readUtf8()).jsonObject.getValue("boxes").jsonArray.size)
}

@Test
fun aBatchOfBoxesAloneIsStillSent() = runTest {
    // An empty outbox with unacknowledged boxes is not empty.
    seedClosedBox("box-1", "046800899000000018")
    server.enqueue(MockResponse().setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[]}"""))
    assertTrue(engine.drainAll())
    val body = json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
    assertEquals(0, body.getValue("items").jsonArray.size)
    assertEquals(1, body.getValue("boxes").jsonArray.size)
}
```

`batchIdOf(request)` reads `batchId` out of the recorded body.

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*SyncEngineTest*"
```

Expected: FAIL — the request carries no `boxes`.

- [ ] **Step 3: Add the closure DTO**

In `SyncDtos.kt`:

```kotlin
/**
 * A box closure as `station-scans/dto.ts` expects it. Scoped with shift and
 * terminal because a device-local box id is not globally unique.
 *
 * `printVerifiedAt`/`printSkippedAt` are always null: print verification is
 * the station's scan-the-label-back reconciliation and is not in this slice.
 */
@Serializable
data class BoxClosureDto(
    val boxId: String,
    val shiftId: String,
    val terminalId: String?,
    val sscc: String,
    val closedAt: String,
    val operatorId: String?,
    val printVerifiedAt: String? = null,
    val printSkippedAt: String? = null,
)

@Serializable
data class SyncBatchRequest(
    val batchId: String,
    val items: List<SyncItemDto>,
    val boxes: List<BoxClosureDto> = emptyList(),
)
```

- [ ] **Step 4: Extend the drain**

In `MetaStore.kt` add `const val SYNC_PENDING_BOX_COUNT = "sync.pendingBoxCount"`.

In `SyncEngine.kt`, replace the early return and the batch build:

```kotlin
val pendingCeiling = meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull()
val rows = if (pendingCeiling != null) db.outboxDao().headThrough(pendingCeiling, BATCH_SIZE) else db.outboxDao().head(BATCH_SIZE)
// A batch in flight re-reads the EXACT box set it already chose. `unacked` is
// ordered by (closedAt, boxId) and nothing can close earlier than a box that
// already closed, so the first N rows are stable — which is what keeps a retry
// byte-identical. Boxes closed since simply wait for the next batch.
val pendingBoxes = meta.get(MetaStore.SYNC_PENDING_BOX_COUNT)?.toIntOrNull()
val boxRows = db.boxDao().unacked(if (pendingCeiling != null && pendingBoxes != null) pendingBoxes else MAX_BOX_CLOSURES)
// An empty outbox with unacknowledged boxes is not empty.
if (rows.isEmpty() && boxRows.isEmpty()) {
    if (pendingCeiling != null) clearPending()
    return Step.EMPTY
}
val maxId = rows.lastOrNull()?.id ?: pendingCeiling ?: 0L
val boxIds = boxRows.map { it.boxId }
val batchId = meta.get(MetaStore.SYNC_PENDING_BATCH_ID)?.takeIf { pendingCeiling != null } ?: run {
    // The box set is folded in: without it, a box closing while this batch
    // awaits acknowledgement would be resent under an id the server has
    // already applied, and the closure would vanish silently.
    val id = "${cfg.deviceId}:${meta.installId()}:$maxId:${boxSignature(boxIds)}"
    meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
    meta.put(MetaStore.SYNC_PENDING_BOX_COUNT, boxIds.size.toString())
    meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
    id
}
val body = json.encodeToString(
    SyncBatchRequest.serializer(),
    SyncBatchRequest(batchId, rows.map { it.toItem(cfg.deviceId) }, boxRows.map { it.toClosure(cfg.deviceId) }),
)
```

and inside the acknowledged transaction, after `deleteThrough(maxId)`:

```kotlin
// Unconditional, unlike the station's: nothing in a handheld box payload can
// change after close, because print state never leaves this device. When
// print verification is added, the station's conditional ack comes back too.
if (boxIds.isNotEmpty()) db.boxDao().markAcked(boxIds, Iso.format(at))
db.metaDao().remove(MetaStore.SYNC_PENDING_BOX_COUNT)
```

`clearPending()` gains the same removal, so an abandoned pending batch does not
pin a stale box count onto the next one.

with the helpers:

```kotlin
/** Short and stable: the same set always signs the same, a different set never does. */
private fun boxSignature(boxIds: List<String>): String =
    if (boxIds.isEmpty()) "0" else "${boxIds.size}-${boxIds.joinToString(",").hashCode().toUInt().toString(16)}"

private fun BoxEntity.toClosure(terminalId: String) = BoxClosureDto(
    boxId = boxId,
    shiftId = shiftId,
    terminalId = terminalId,
    sscc = checkNotNull(sscc),
    closedAt = checkNotNull(closedAt),
    operatorId = operatorId,
)
```

and `private const val MAX_BOX_CLOSURES = 50` next to `BATCH_SIZE`, matching the server's `MAX_BOX_CLOSURES_PER_SYNC_BATCH`.

Also relax the shape guard so a boxes-only batch is accepted:

```kotlin
if (!parsed.alreadyApplied && parsed.applied != rows.size) return Step.FAILED
```

stays correct as written — `rows.size` is zero for a boxes-only batch and the server reports `applied: 0`.

- [ ] **Step 5: Run to see it pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*SyncEngineTest*"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): carry box closures in the scan batch"
```

---

### Task 10: The work screen in aggregation mode

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/BoxFill.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkViewModel.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkScreen.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/signal/Signaller.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt` (modify), `.../BoxFillTest.kt` (create)

**Interfaces:**

- Consumes: `BoxRepository`, `CloseBox`, `BoxPrinter`, `ScanRecorder.record(..., boxId)`
- Produces: `WorkUi.box: BoxUi?` where `data class BoxUi(ordinal: Int, filled: Int, capacity: Int)`; `SignalKind.BOX_DONE`

- [ ] **Step 1: Write the failing tests**

Add to `WorkViewModelTest.kt`:

```kotlin
@Test
fun aScanInAnAggregationShiftJoinsTheOpenBox() = runTest {
    val model = aggregationModel()
    scans.emit(VALID_KM)
    advanceUntilIdle()
    val box = model.state.first { it.box != null }.box!!
    assertEquals(1, box.ordinal)
    assertEquals(1, box.filled)
    assertEquals(20, box.capacity)
}

@Test
fun theLastUnitClosesTheBoxAndPlaysItsOwnSignal() = runTest {
    val model = aggregationModel(capacity = 2)
    scans.emit(KM_1)
    scans.emit(KM_2)
    advanceUntilIdle()
    assertTrue(signals.played.contains(SignalKind.BOX_DONE))
    assertNotNull(db.boxDao().unacked(10).single().sscc)
}

@Test
fun aValidationShiftHasNoBox() = runTest {
    val model = validationModel()
    scans.emit(VALID_KM)
    advanceUntilIdle()
    assertNull(model.state.value.box)
    assertNull(db.outboxDao().head(1).single().boxId)
}
```

Create `BoxFillTest.kt`:

```kotlin
package app.markiro.handheld.feature.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxFillTest {
    @Test
    fun aTwentyUnitBoxIsDrawnAsAGrid() {
        assertTrue(showsGrid(20))
        assertEquals(5, gridColumns(20))
    }

    @Test
    fun aBoxOfHundredsBecomesACounter() {
        // Sixty is six rows of ten, the most that still reads as countable at
        // the mockup's cell size on a 360 dp screen.
        assertTrue(showsGrid(60))
        assertFalse(showsGrid(61))
        assertFalse(showsGrid(120))
    }
}
```

- [ ] **Step 2: Run to see them fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*WorkViewModelTest*" --tests "*BoxFillTest*"
```

Expected: FAIL — `WorkUi.box`, `SignalKind.BOX_DONE`, `showsGrid` are unresolved.

- [ ] **Step 3: Add the fourth signal**

In `Signaller.kt`, add to `SignalKind`:

```kotlin
/** Short-short, and a pitch above OK so a full box is not mistaken for one more accepted unit. */
BOX_DONE(1_320.0, 90, Wave.SINE, longArrayOf(0, 40, 60, 40)),
```

- [ ] **Step 4: Write the fill component**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/BoxFill.kt`:

```kotlin
package app.markiro.handheld.feature.work

import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Above this many units the cells stop being countable on a 360 dp screen, so
 * the grid gives way to a large counter rather than pretending a hundred dots
 * can be read at a glance. Sixty is six rows of ten at the mockup's cell size.
 */
const val GRID_MAX_CAPACITY = 60

fun showsGrid(capacity: Int): Boolean = capacity in 1..GRID_MAX_CAPACITY

/** Columns for a roughly square grid, capped at ten so cells stay wide enough to see. */
fun gridColumns(capacity: Int): Int =
    if (capacity <= 0) 1 else min(10, ceil(sqrt(capacity.toDouble())).toInt())

fun gridRows(capacity: Int): Int =
    if (capacity <= 0) 1 else ceil(capacity.toDouble() / gridColumns(capacity)).toInt()
```

Then add the `@Composable fun BoxFill(filled: Int, capacity: Int, modifier: Modifier)` that draws either the grid (filled / current / empty cells, using `MarkiroColors` tokens) or the counter, in the same file.

- [ ] **Step 5: Wire the view model**

In `WorkViewModel.kt` add `data class BoxUi(val ordinal: Int, val filled: Int, val capacity: Int)` and `val box: BoxUi? = null` to `WorkUi`. Inject `BoxRepository`, `CloseBox` and `BoxPrinter`. Replace `onScan`:

```kotlin
private suspend fun onScan(raw: String) {
    val shift = db.shiftDao().get(shiftId) ?: return
    if (shift.productGtin14 == null || shift.status == "closed") return
    val aggregating = shift.mode == "aggregation"
    val box = if (aggregating) boxes.currentBox(shiftId) else null
    val outcome = recorder.record(shift, raw, session.state.value.operator?.operatorId, box?.boxId)
    last.value = outcome.toLastScan(raw)
    sync.nudge()

    val capacity = shift.boxCapacity ?: 0
    if (aggregating && box != null && outcome.verdict == Verdict.OK && capacity > 0 &&
        boxes.itemCount(box.boxId) >= capacity
    ) {
        // The box's own signal, not one more accepted unit.
        signals.play(SignalKind.BOX_DONE)
        closeAndPrint(shift, box.boxId)
        return
    }
    signals.play(Signaller.forVerdict(outcome.verdict))
}
```

with `closeAndPrint` setting a `MutableStateFlow<BoxCloseStep>` that Task 11 renders, and `fun closeEarly()` calling the same path for the overflow action.

- [ ] **Step 6: Run to see them pass**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): the aggregation work screen and its fill grid"
```

---

### Task 11: The box-close screens

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/BoxCloseScreens.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkViewModel.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/BoxCloseScreensTest.kt`

**Interfaces:**

- Consumes: `PrintOutcome`, `CloseResult`
- Produces: `sealed interface BoxCloseStep { Idle; Closing; data class Printing(ordinal, sscc, itemCount); data class Printed(...); data class Failed(..., reason); data class Unknown(..., cause); data class Refused(result: CloseResult) }` and `BoxCloseScreen(step, callbacks)`

- [ ] **Step 1: Write the failing test**

Create `BoxCloseScreensTest.kt` (Robolectric, both languages):

```kotlin
@Test
fun aPrintedBoxNamesItsSsccAndDismissesItself() {
    compose.setContent { BoxCloseScreen(BoxCloseStep.Printed(27, "046800899000000018", 20), callbacks) }
    compose.onNodeWithText("Короб 27 закрыт").assertIsDisplayed()
    compose.onNodeWithText("046800899000000018", substring = true).assertIsDisplayed()
}

@Test
fun anUnknownResultOffersNoAutomaticRetry() {
    compose.setContent { BoxCloseScreen(BoxCloseStep.Unknown(27, "046800899000000018", 20, "link lost"), callbacks) }
    compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
    compose.onNodeWithText("Этикетка напечаталась").assertIsDisplayed()
    compose.onNodeWithText("Напечатать ещё раз").assertIsDisplayed()
    compose.onNodeWithText("Отложить этикетку").assertIsDisplayed()
}

@Test
fun aDryPoolSaysSoRatherThanFailingToPrint() {
    compose.setContent { BoxCloseScreen(BoxCloseStep.Refused(CloseResult.NoSerials), callbacks) }
    compose.onNodeWithText("Закончились номера SSCC").assertIsDisplayed()
}

@Test
fun everyStateRendersInEnglish() {
    // Same assertions against values-en, so a missing translation fails here
    // rather than on a factory floor.
}
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*BoxCloseScreensTest*"
```

Expected: FAIL — `BoxCloseScreen` is unresolved.

- [ ] **Step 3: Write the screens**

Create `BoxCloseScreens.kt` with `BoxCloseStep` and the composable, following the shape of `PrinterScreens.kt` from #491: a callbacks data class (`onConfirmPrinted`, `onRetry`, `onOtherPrinter`, `onDefer`, `onDismiss`), full-screen states, and `LaunchedEffect` dismissing `Printed` after 1 second.

- [ ] **Step 4: Wire it into navigation**

Show `BoxCloseScreen` as an overlay over the work screen while `step != Idle`, so the fill grid is not rebuilt underneath.

- [ ] **Step 5: Run the gate**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): the four box-close states"
```

---

### Task 12: The deferred-label queue

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/LabelQueueViewModel.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/LabelQueueScreen.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub/HubViewModel.kt`, `HubScreen.kt`, `WorkScreen.kt`, `AppNavigation.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/LabelQueueViewModelTest.kt`

**Interfaces:**

- Consumes: `BoxRepository.observeUnprinted`, `BoxPrinter.print`
- Produces: `LabelQueueViewModel` with `state: StateFlow<LabelQueueUi>`, `fun printOne(boxId: String)`, `fun printAll()`, `fun resolveUnknown(boxId: String)`; `HubUi.unprintedLabels: Int`

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test
fun theQueueListsClosedBoxesWhoseLabelIsNotResolved() = runTest {
    seedBox("box-1", printState = "failed")
    seedBox("box-2", printState = "printed")
    assertEquals(listOf("box-1"), model.state.first { it.items.isNotEmpty() }.items.map { it.boxId })
}

@Test
fun printAllSkipsABoxWhoseLastAttemptIsUnknown() = runTest {
    // Retrying an unknown would put a second label on a box the server has
    // already accepted, which is exactly what the state exists to prevent.
    seedBox("box-1", printState = "failed")
    seedBox("box-2", printState = "unknown")
    model.printAll()
    advanceUntilIdle()
    assertEquals(listOf("box-1"), printer.printed)
}

@Test
fun resolvingAnUnknownLetsItBePrintedAgain() = runTest {
    seedBox("box-1", printState = "unknown")
    model.resolveUnknown("box-1")
    advanceUntilIdle()
    assertEquals("printed", db.boxDao().get("box-1")!!.printState)
    // Nothing was sent: the operator looked at the printer and said so.
    assertEquals(emptyList<String>(), printer.printed)
}

@Test
fun theQueueOutlivesTheShiftThatFilledIt() = runTest {
    seedBox("box-1", printState = "failed", shiftStatus = "closed")
    assertEquals(1, model.state.first { it.items.isNotEmpty() }.items.size)
}
```

- [ ] **Step 2: Run to see them fail**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest --tests "*LabelQueueViewModelTest*"
```

Expected: FAIL — `LabelQueueViewModel` is unresolved.

- [ ] **Step 3: Write the view model**

```kotlin
@HiltViewModel
class LabelQueueViewModel @Inject constructor(
    private val boxes: BoxRepository,
    private val printer: BoxPrinter,
) : ViewModel() {
    val state: StateFlow<LabelQueueUi> = boxes.observeUnprinted()
        .map { rows -> LabelQueueUi(rows.map { it.toItem() }) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LabelQueueUi(emptyList()))

    fun printOne(boxId: String) {
        viewModelScope.launch { printer.print(boxId) }
    }

    /**
     * Skips every box whose last attempt is `unknown`. A retry there could put
     * a second label on a box the server has already accepted, so only a person
     * who has looked at the printer resolves one.
     */
    fun printAll() {
        viewModelScope.launch {
            for (item in state.value.items) {
                if (item.printState == "unknown") continue
                printer.print(item.boxId)
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun resolveUnknown(boxId: String) {
        viewModelScope.launch { boxes.setPrintState(boxId, "printed", null) }
    }
}
```

- [ ] **Step 4: Write the screen and the counters**

`LabelQueueScreen` lists one `hh/ListRow` per box (SSCC tail, reason, time), with per-item «Повторить» and a primary «Напечатать все». Add `unprintedLabels` to `HubUi`, render «N этикеток не напечатано» on the context card, and the same line in the work screen header, both routing to the queue.

Call `boxes.demoteInterruptedPrints()` once at application start, next to the existing startup work.

- [ ] **Step 5: Run the gate**

```bash
cd apps/handheld && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src
git commit -m "feat(handheld): the deferred-label queue"
```

---

### Task 13: Strings, docs and the manual walk-through

**Files:**

- Modify: `apps/handheld/app/src/main/res/values/strings.xml`, `apps/handheld/app/src/main/res/values-en/strings.xml`
- Modify: `apps/handheld/README.md`, `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-09-10-handheld-aggregation-boxes-design.md` (status line)

- [ ] **Step 1: Confirm both string files agree**

```bash
cd apps/handheld && ./gradlew lintDebug
```

Expected: zero errors. `MissingTranslation` is an error in this project, so a key present in one file and absent in the other fails here.

- [ ] **Step 2: Document the contour**

In `apps/handheld/README.md`, add an «Агрегация» section: boxes are device-local, the SSCC pool comes from the shift bundle and is topped up by refetching it, a box closes without a printer and the label queues, and `unknown` never resends by itself.

In `docs/architecture.md`, record the one decision that is not a port: box acknowledgement is unconditional because print state never leaves the handheld, and print verification re-introduces the station's conditional rule.

- [ ] **Step 3: Run the manual emulator walk-through**

Start the stand-in printer, pair the emulator, sign in, enter an aggregation shift and confirm each of these by hand:

1. Scanning units fills the grid; the box number is stable across an app restart.
2. The last unit closes the box, prints, and the screen dismisses itself.
3. The captured document carries the bare 18-digit SSCC, the Cyrillic product name as an image field, and «Годен до» one day short of production + shelf life.
4. Out of paper: nothing is sent, the reason is the printer's own.
5. Kill the app mid-print; on restart the box reads `unknown`, and «Напечатать все» skips it.
6. Remove the printer entirely: boxes still close, the queue fills, the hub says so.
7. Exhaust the pool: the box stays open and says why.
8. Close the shift with a non-empty queue: it closes, and the queue is still there.
9. English throughout.

Record what was found. In the printing slice this step found four defects no unit test caught.

- [ ] **Step 4: Update the spec status and commit**

```bash
git add apps/handheld docs
git commit -m "docs(handheld): document the aggregation contour"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: decomposition → the plan's scope; data on the device → Task 3; the SSCC pool's two verbatim properties → Task 4; the close pipeline's five ordered steps → Task 6; `closedAt` as the date source → Tasks 2, 6 and 8; print outcomes → Task 8; the `unknown` skip rule → Tasks 11 and 12; sync additions and the batch-id trap → Task 9; screens → Tasks 10–12; the fourth signal → Task 10; fixtures → Tasks 1–2; the manual walk-through → Task 13.

**One deviation from the spec, deliberate.** The spec lists `itemCount` as a column on `boxes`. It is not: the station derives it by counting code rows that name the box, so the count can never disagree with the rows themselves. The plan follows the station.

**One addition.** The spec names SSCC construction as the fixture set. The plan widens it to the box label's whole field record, because the inclusive-expiry rule (`productionDate + N - 1`) is the other calculation that must not drift, and the root `AGENTS.md` calls out one-day, leap-year and timezone cases by name.
