# Handheld GS1 DataMatrix encoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the handheld print a GS1 DataMatrix, which both of its label emitters refuse today, so the duplicate-printing slice has something to print with.

**Architecture:** A Chestny ZNAK marking code becomes a stream of ECC200 codewords (leading FNC1, FNC1 in place of every AI separator, ASCII encodation with digit-pair compaction, spec padding), which ZXing turns into error-corrected, placed modules; we compose those modules into a finished symbol, scale it into the square the template reserved, and emit it through the raster path the handheld already has. No native printer DataMatrix command is used: TSPL's `DMATRIX` cannot carry FNC1 at all, so a natively printed code would not be a GS1 code.

**Tech Stack:** Kotlin 2.2, `com.google.zxing:core` (new), JUnit 4, the existing `core/label` raster helpers.

## Global Constraints

- Target module is `apps/handheld`. **Run every command in this plan from `apps/handheld`**, and read every path in a `git add` as relative to it.
- `minSdk = 28`. ZXing core is plain Java 8 bytecode with no AWT and no Android dependency; add it as `implementation`, not `compileOnly`.
- Kotlin sources live under `app/src/main/kotlin/app/markiro/handheld/`, tests under `app/src/test/kotlin/app/markiro/handheld/`.
- Version-catalog entries go in `gradle/libs.versions.toml` with an exact version, matching every existing entry.
- Never write a raw control byte into a source file. The GS separator is `'\u001d'` as a `Char` and `"\u001d"` as a `String`, exactly as `KmCodec.GS` already declares it.
- Failures an operator can cause (a code too long for the largest symbol, a template square too small) must be thrown as `LabelRenderException`, which `BoxPrinter` already translates into `render_failed`. Do not let them escape as `IllegalArgumentException` or `NullPointerException`.
- **This port is deliberately NOT byte-pinned to `packages/domain`.** The domain encodes through `bwip-js`; a different encoder may legitimately choose a different symbol size or encodation. Nothing ever compares one device's label bytes with another's — the server stores a digest of each device's own bytes, and verification compares the _scanned payload_, not the bytes. The contract is that the printed symbol decodes to the right GS1 payload, and that is what the tests assert. Do not add these cases to `label-fixtures.json`.
- The only DataMatrix the handheld renders is the `km.code` field. Any other barcode format, and a `datamatrix` bound to anything else, keeps throwing "not supported on this device".
- Gates before completion, from `apps/handheld`:
  `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`

---

### Task 1: GS1 codeword stream

The one part no library provides: GS1 framing (FNC1 first, FNC1 for each separator) and ECC200 ASCII encodation with digit-pair compaction and spec padding. Pure Kotlin, no ZXing, and every expected value below is derivable by hand from ISO/IEC 16022.

**Files:**

- Create: `app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1Codewords.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1CodewordsTest.kt`

**Interfaces:**

- Consumes: `LabelRenderException` from `app.markiro.handheld.core.label`.
- Produces:
  - `fun gs1Codewords(canonicalRaw: String): IntArray` — unpadded codewords, always starting with 232.
  - `fun padCodewords(codewords: IntArray, capacity: Int): IntArray` — pads to exactly `capacity`.
  - `const val FNC1 = 232`

- [ ] **Step 1: Write the failing test**

Create `app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1CodewordsTest.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** GS1's AI separator, written as an escape so no control byte lands in this file. */
private const val GS = "\u001d"

class Gs1CodewordsTest {
    /**
     * "01" plus a GTIN-14 is sixteen digits, so ASCII encodation pairs all of
     * them: a pair's codeword is 130 plus its two-digit value.
     */
    @Test
    fun digitsArePairedAfterTheLeadingFnc1() {
        assertArrayEquals(
            intArrayOf(232, 131, 134, 190, 136, 212, 130, 130, 143),
            gs1Codewords("0104600682000013"),
        )
    }

    /** A separator is an FNC1 codeword, never the literal GS byte, and pairing restarts after it. */
    @Test
    fun separatorsBecomeFnc1AndBreakPairing() {
        assertArrayEquals(
            intArrayOf(232, 151, 66, 232, 223, 67),
            gs1Codewords("21A${GS}93B"),
        )
    }

    /** An unpaired trailing digit falls back to plain ASCII: its code plus one. */
    @Test
    fun anOddTrailingDigitIsEncodedAsAscii() {
        assertArrayEquals(intArrayOf(232, 151, 52), gs1Codewords("213"))
    }

    /**
     * The first pad is a plain 129; every later one is randomised by its own
     * 1-based position, which is what stops a run of identical modules.
     */
    @Test
    fun paddingIsPlainThenRandomised() {
        assertArrayEquals(
            intArrayOf(232, 131, 134, 190, 136, 212, 130, 130, 143, 129, 251, 147),
            padCodewords(gs1Codewords("0104600682000013"), 12),
        )
    }

    @Test
    fun paddingAnAlreadyFullStreamChangesNothing() {
        val codewords = gs1Codewords("0104600682000013")
        assertArrayEquals(codewords, padCodewords(codewords, codewords.size))
    }

    @Test
    fun aStreamLongerThanTheCapacityIsRejected() {
        val codewords = gs1Codewords("0104600682000013")
        val error = assertThrows(LabelRenderException::class.java) {
            padCodewords(codewords, codewords.size - 1)
        }
        assertTrue(error.message.orEmpty().contains("capacity"))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*Gs1CodewordsTest*'`
Expected: FAIL — compilation error, `Unresolved reference: gs1Codewords`.

- [ ] **Step 3: Write the implementation**

Create `app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1Codewords.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException

/** ECC200's function-1 codeword. First in the stream it declares GS1 data; later it separates AIs. */
const val FNC1 = 232

/** ECC200's first pad codeword; every pad after it is randomised by position. */
private const val PAD = 129
private const val UPPER_SHIFT = 235
private const val GS = '\u001d'

/**
 * A canonical marking code as an unpadded ECC200 codeword stream.
 *
 * The leading FNC1 is what makes the symbol a GS1 Data Matrix rather than a
 * Data Matrix that happens to contain AIs, and each separator becomes an FNC1
 * codeword rather than a literal GS byte -- a scanner re-emits it as GS when it
 * decodes, which is why the round-trip test expects the separators back.
 *
 * ASCII encodation only. C40, Text, X12, EDIFACT and Base256 would produce a
 * smaller symbol for some codes; none of them would produce a MORE correct one,
 * and each is a separate latch/unlatch state machine to get wrong.
 */
fun gs1Codewords(canonicalRaw: String): IntArray {
    val out = ArrayList<Int>(canonicalRaw.length + 1)
    out += FNC1
    var i = 0
    while (i < canonicalRaw.length) {
        val ch = canonicalRaw[i]
        when {
            ch == GS -> {
                out += FNC1
                i += 1
            }
            ch.isAsciiDigit() && i + 1 < canonicalRaw.length && canonicalRaw[i + 1].isAsciiDigit() -> {
                out += 130 + (ch - '0') * 10 + (canonicalRaw[i + 1] - '0')
                i += 2
            }
            ch.code < 128 -> {
                out += ch.code + 1
                i += 1
            }
            ch.code < 256 -> {
                out += UPPER_SHIFT
                out += ch.code - 128 + 1
                i += 1
            }
            else -> throw LabelRenderException("marking code contains a character the symbol cannot carry")
        }
    }
    return out.toIntArray()
}

/**
 * Pads a stream to a symbol's data capacity.
 *
 * The first pad is a plain 129 and the rest are randomised against their own
 * 1-based position in the stream, exactly as the standard specifies: a long
 * tail of identical pad codewords would otherwise print as a regular block of
 * modules that reads poorly.
 */
fun padCodewords(codewords: IntArray, capacity: Int): IntArray {
    if (codewords.size > capacity) {
        throw LabelRenderException("marking code needs ${codewords.size} codewords, capacity is $capacity")
    }
    if (codewords.size == capacity) return codewords
    val out = codewords.copyOf(capacity)
    out[codewords.size] = PAD
    for (index in codewords.size + 1 until capacity) {
        // `index` is zero-based; the standard's position is one-based.
        val pseudoRandom = (149 * (index + 1)) % 253 + 1
        val value = PAD + pseudoRandom
        out[index] = if (value <= 254) value else value - 254
    }
    return out
}

private fun Char.isAsciiDigit(): Boolean = this in '0'..'9'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*Gs1CodewordsTest*'`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1Codewords.kt app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1CodewordsTest.kt
git commit -m "feat(handheld): GS1 ECC200 codeword stream"
```

---

### Task 2: Symbol assembly

Turns the codeword stream into a finished module grid: ZXing picks the symbol size, adds Reed–Solomon error correction and places the data modules; we add the finder and clock patterns around each data region. The test decodes the result with ZXing's own decoder, which is what a real scanner does.

**Files:**

- Modify: `gradle/libs.versions.toml`
- Modify: `app/build.gradle.kts`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/barcode/DataMatrix.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/barcode/DataMatrixTest.kt`

**Interfaces:**

- Consumes: `gs1Codewords(canonicalRaw: String): IntArray` and `padCodewords(codewords: IntArray, capacity: Int): IntArray` from Task 1.
- Produces:
  - `class ModuleGrid(val width: Int, val height: Int, val modules: BooleanArray)` with `operator fun get(x: Int, y: Int): Boolean`
  - `fun encodeGs1DataMatrix(canonicalRaw: String): ModuleGrid`

- [ ] **Step 1: Add the dependency**

In `gradle/libs.versions.toml`, add to `[versions]` after the `securityCrypto = "1.1.0"` line:

```toml
zxing = "3.5.4"
```

and to `[libraries]` after the `androidx-security-crypto = ...` line:

```toml
zxing-core = { module = "com.google.zxing:core", version.ref = "zxing" }
```

In `app/build.gradle.kts`, add after the `implementation(libs.androidx.security.crypto)` line:

```kotlin
    implementation(libs.zxing.core)
```

- [ ] **Step 2: Confirm the ZXing API surface before building on it**

The classes below are public ZXing API, but member names are worth confirming once rather than discovering three files later. Create `app/src/test/kotlin/app/markiro/handheld/core/barcode/DataMatrixTest.kt` with only this for now:

```kotlin
package app.markiro.handheld.core.barcode

import com.google.zxing.datamatrix.encoder.SymbolInfo
import com.google.zxing.datamatrix.encoder.SymbolShapeHint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DataMatrixTest {
    @Test
    fun zxingExposesTheSymbolTableWeRelyOn() {
        val info = SymbolInfo.lookup(12, SymbolShapeHint.FORCE_SQUARE)
        assertEquals(16, info.symbolWidth)
        assertEquals(16, info.symbolHeight)
        assertEquals(12, info.dataCapacity)
        assertEquals(12, info.errorCodewords)
        // Data-region geometry, used below to place the finder and clock patterns.
        assertEquals(14, info.symbolDataWidth)
        assertEquals(14, info.symbolDataHeight)
        assertEquals(14, info.matrixWidth)
        assertEquals(14, info.matrixHeight)
        assertTrue(info.symbolWidth >= info.symbolDataWidth)
    }
}
```

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DataMatrixTest*'`
Expected: PASS.

If a **member name** differs, the jar is the source of truth: fix the call here and use the corrected names for the rest of this task. If a **value** differs, stop and report — the symbol table is not what this plan assumed, and the placement code below has to be re-derived against it.

- [ ] **Step 3: Write the failing round-trip test**

Merge these imports into `DataMatrixTest.kt`'s existing import block:

```kotlin
import app.markiro.handheld.core.label.LabelRenderException
import com.google.zxing.common.BitMatrix
import com.google.zxing.datamatrix.decoder.Decoder
import org.junit.Assert.assertThrows
```

Add above the class:

```kotlin
private const val GS = "\u001d"

private fun ModuleGrid.toBitMatrix(): BitMatrix {
    val matrix = BitMatrix(width, height)
    for (y in 0 until height) {
        for (x in 0 until width) {
            if (this[x, y]) matrix.set(x, y)
        }
    }
    return matrix
}

/**
 * What a scanner reads back. ZXing renders every FNC1 codeword as ASCII 29,
 * including the leading one, so a correct GS1 symbol decodes to a separator
 * followed by the code with its own separators intact. Anything less means the
 * symbol is a plain Data Matrix that a Chestny ZNAK scanner would misread.
 */
private fun decode(grid: ModuleGrid): String = Decoder().decode(grid.toBitMatrix()).text
```

Add these tests inside the class:

```kotlin
    @Test
    fun aShortCodeDecodesBackToItselfBehindTheGs1Flag() {
        val raw = "0104600682000013215Y7HG9"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    @Test
    fun everySeparatorSurvivesAsASeparator() {
        val raw = "0104600682000013215Y7HG9${GS}93Zf8K"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    /** A production Chestny ZNAK code: long serial, 91 and 92 present, crypto tail included. */
    @Test
    fun aFullProductionCodeDecodesBackToItself() {
        val raw = "010460068200001321AbC5xY9k2Qw${GS}91EE10${GS}92" +
            "RG5RMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MA"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    @Test
    fun theSymbolIsSquareAndLargeEnoughForItsData() {
        val grid = encodeGs1DataMatrix("0104600682000013215Y7HG9")
        assertEquals(grid.width, grid.height)
        assertTrue(grid.width in 10..144)
    }

    @Test
    fun aCodeTooLongForTheLargestSymbolIsRefusedAsARenderFailure() {
        val raw = "010460068200001321" + "A".repeat(2000)
        assertThrows(LabelRenderException::class.java) { encodeGs1DataMatrix(raw) }
    }
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DataMatrixTest*'`
Expected: FAIL — compilation error, `Unresolved reference: encodeGs1DataMatrix`.

- [ ] **Step 5: Write the implementation**

Create `app/src/main/kotlin/app/markiro/handheld/core/barcode/DataMatrix.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import com.google.zxing.datamatrix.encoder.DefaultPlacement
import com.google.zxing.datamatrix.encoder.ErrorCorrection
import com.google.zxing.datamatrix.encoder.SymbolInfo
import com.google.zxing.datamatrix.encoder.SymbolShapeHint

/** A finished symbol: one boolean per module, row major, true is black. */
class ModuleGrid(val width: Int, val height: Int, val modules: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = modules[y * width + x]
}

/**
 * A canonical marking code as a printable GS1 Data Matrix.
 *
 * Only the framing is ours. Choosing the symbol size, computing Reed-Solomon
 * error correction and placing the data modules are ZXing's -- all three are
 * fiddly, all three are identical for every Data Matrix ever made, and a subtle
 * error in any of them produces a symbol that looks right and scans wrong.
 * What ZXing will not do is GS1, which is why the codeword stream is built here.
 *
 * Square symbols only. A rectangular one would be legal, but the template
 * reserves a square, and a template author sizing a square around an 8x32
 * symbol is a worse failure than a slightly larger square symbol.
 */
fun encodeGs1DataMatrix(canonicalRaw: String): ModuleGrid {
    val codewords = gs1Codewords(canonicalRaw)
    val info = runCatching { SymbolInfo.lookup(codewords.size, SymbolShapeHint.FORCE_SQUARE) }.getOrNull()
        ?: throw LabelRenderException("marking code is too long for a Data Matrix symbol")
    val padded = padCodewords(codewords, info.dataCapacity)
    val encoded = ErrorCorrection.encodeECC200(String(CharArray(padded.size) { padded[it].toChar() }), info)
    val placement = DefaultPlacement(encoded, info.symbolDataWidth, info.symbolDataHeight)
    placement.place()
    return compose(placement, info)
}

/**
 * Wraps the placed data regions in their patterns: a solid L down the left and
 * along the bottom of each region, and an alternating clock track along its top
 * and right. A symbol of 32 modules or more carries several regions, each with
 * its own full set, which is why this walks regions rather than the outer edge.
 */
private fun compose(placement: DefaultPlacement, info: SymbolInfo): ModuleGrid {
    val width = info.symbolWidth
    val height = info.symbolHeight
    val modules = BooleanArray(width * height)
    fun set(x: Int, y: Int, value: Boolean) {
        modules[y * width + x] = value
    }

    var matrixY = 0
    for (y in 0 until info.symbolDataHeight) {
        if (y % info.matrixHeight == 0) {
            for (x in 0 until width) set(x, matrixY, x % 2 == 0)
            matrixY += 1
        }
        var matrixX = 0
        for (x in 0 until info.symbolDataWidth) {
            if (x % info.matrixWidth == 0) {
                set(matrixX, matrixY, true)
                matrixX += 1
            }
            set(matrixX, matrixY, placement.getBit(x, y))
            matrixX += 1
            if (x % info.matrixWidth == info.matrixWidth - 1) {
                set(matrixX, matrixY, y % 2 == 0)
                matrixX += 1
            }
        }
        matrixY += 1
        if (y % info.matrixHeight == info.matrixHeight - 1) {
            for (x in 0 until width) set(x, matrixY, true)
            matrixY += 1
        }
    }
    return ModuleGrid(width, height, modules)
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DataMatrixTest*'`
Expected: PASS, 6 tests. A decode failure here is in the composition, not the codewords: Task 1's tests already pin those.

- [ ] **Step 7: Commit**

```bash
git add gradle/libs.versions.toml app/build.gradle.kts app/src/main/kotlin/app/markiro/handheld/core/barcode/DataMatrix.kt app/src/test/kotlin/app/markiro/handheld/core/barcode/DataMatrixTest.kt
git commit -m "feat(handheld): assemble a scannable GS1 Data Matrix symbol"
```

---

### Task 3: Raster and both emitters

Scales the symbol into the square the template reserved and renders it through the raster path the handheld already uses for Cyrillic text, in both printer languages.

**Files:**

- Create: `app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRaster.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpec.kt` (the `sizeMm` doc comment on `LabelElement.Barcode`, line 118)
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt` (the `barcode` function, line 115)
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt` (the `Barcode` dispatch, line 46, and the `barcode` function, line 125)
- Modify: `README.md`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRasterTest.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/label/DataMatrixEmitTest.kt`

**Interfaces:**

- Consumes: `encodeGs1DataMatrix(canonicalRaw: String): ModuleGrid` and `ModuleGrid` from Task 2; `RasterResult`, `bitmapToZplHex`, `buildGfaCommand`, `buildBitmapCommand`, `tsplBitmapBytes`, `mmToDots`, `LabelRenderException` from `app.markiro.handheld.core.label`.
- Produces: `fun rasterizeGs1DataMatrix(canonicalRaw: String, sideDots: Int): RasterResult`

- [ ] **Step 1: Write the failing raster test**

Create `app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRasterTest.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.RasterResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RAW = "0104600682000013215Y7HG9\u001d93Zf8K"

/** Reads one pixel back out of the packing: rows pad to whole bytes, most significant bit leftmost. */
private fun RasterResult.pixel(x: Int, y: Int): Boolean {
    val byteIndex = y * bytesPerRow + x / 8
    val byte = hex.substring(byteIndex * 2, byteIndex * 2 + 2).toInt(16)
    return (byte shr (7 - x % 8)) and 1 == 1
}

class Gs1DataMatrixRasterTest {
    @Test
    fun theRasterIsTheRequestedSquare() {
        val raster = rasterizeGs1DataMatrix(RAW, 120)
        assertEquals(120, raster.width)
        assertEquals(120, raster.height)
        assertEquals(15, raster.bytesPerRow)
        assertEquals(15 * 120, raster.totalBytes)
        assertEquals(raster.totalBytes * 2, raster.hex.length)
    }

    /**
     * Every module lands where the same formula says it should, at full scale.
     * Task 2 already proved the grid decodes; this proves the scaling carries it
     * faithfully rather than shearing or transposing it.
     */
    @Test
    fun everyModuleIsScaledIntoPlace() {
        val sideDots = 120
        val raster = rasterizeGs1DataMatrix(RAW, sideDots)
        val grid = encodeGs1DataMatrix(RAW)
        val scale = sideDots / (maxOf(grid.width, grid.height) + 2)
        val left = (sideDots - grid.width * scale) / 2
        val top = (sideDots - grid.height * scale) / 2
        assertTrue(scale >= 1)
        for (row in 0 until grid.height) {
            for (column in 0 until grid.width) {
                val expected = grid[column, row]
                for (dy in 0 until scale) {
                    for (dx in 0 until scale) {
                        assertEquals(
                            "module $column,$row offset $dx,$dy",
                            expected,
                            raster.pixel(left + column * scale + dx, top + row * scale + dy),
                        )
                    }
                }
            }
        }
    }

    /** The quiet zone is inside the square: a symbol touching the edge does not scan. */
    @Test
    fun theSquareKeepsABlankBorder() {
        val sideDots = 120
        val raster = rasterizeGs1DataMatrix(RAW, sideDots)
        for (i in 0 until sideDots) {
            assertFalse("top row $i", raster.pixel(i, 0))
            assertFalse("bottom row $i", raster.pixel(i, sideDots - 1))
            assertFalse("left column $i", raster.pixel(0, i))
            assertFalse("right column $i", raster.pixel(sideDots - 1, i))
        }
    }

    @Test
    fun aSquareTooSmallForOneDotPerModuleIsRefused() {
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 8) }
    }

    @Test
    fun anAbsurdSquareIsRefusedBeforeAnythingIsAllocated() {
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 0) }
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 4000) }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*Gs1DataMatrixRasterTest*'`
Expected: FAIL — compilation error, `Unresolved reference: rasterizeGs1DataMatrix`.

- [ ] **Step 3: Write the raster implementation**

Create `app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRaster.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.bitmapToZplHex

/** The largest label this product supports is 300 mm at 300 dpi. */
private const val MAX_SIDE_DOTS = 3543

/**
 * A marking code as a square bitmap, ready for the raster path both emitters
 * already use for text.
 *
 * `sideDots` is the WHOLE symbol square, not a module: a duplicate template
 * reserves the finished square (see `assertDuplicateTemplate` in the domain),
 * unlike an ordinary barcode element whose size is a module width. The scale is
 * chosen against the symbol plus two modules so the quiet zone falls inside the
 * reserved square rather than eating the neighbouring field.
 */
fun rasterizeGs1DataMatrix(canonicalRaw: String, sideDots: Int): RasterResult {
    if (sideDots < 1 || sideDots > MAX_SIDE_DOTS) {
        throw LabelRenderException("Data Matrix extent $sideDots is out of range")
    }
    val grid = encodeGs1DataMatrix(canonicalRaw)
    val scale = sideDots / (maxOf(grid.width, grid.height) + 2)
    if (scale < 1) {
        throw LabelRenderException(
            "Data Matrix needs at least ${grid.width + 2} dots, the template reserves $sideDots",
        )
    }
    val left = (sideDots - grid.width * scale) / 2
    val top = (sideDots - grid.height * scale) / 2
    val bitmap = ByteArray(sideDots * sideDots)
    for (row in 0 until grid.height) {
        for (column in 0 until grid.width) {
            if (!grid[column, row]) continue
            for (dy in 0 until scale) {
                val start = (top + row * scale + dy) * sideDots + left + column * scale
                bitmap.fill(1, start, start + scale)
            }
        }
    }
    val packing = bitmapToZplHex(bitmap, sideDots, sideDots)
    return RasterResult(packing.hex, packing.totalBytes, packing.bytesPerRow, sideDots, sideDots)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*Gs1DataMatrixRasterTest*'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the raster**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRaster.kt app/src/test/kotlin/app/markiro/handheld/core/barcode/Gs1DataMatrixRasterTest.kt
git commit -m "feat(handheld): scale a Data Matrix into the square a template reserves"
```

- [ ] **Step 6: Write the failing emitter test**

Create `app/src/test/kotlin/app/markiro/handheld/core/label/DataMatrixEmitTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import app.markiro.handheld.core.barcode.rasterizeGs1DataMatrix
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RAW = "0104600682000013215Y7HG9\u001d93Zf8K"
private const val DPI = 203

private fun spec(format: BarcodeFormat, source: BarcodeSource) = LabelSpec(
    widthMm = 58.0,
    heightMm = 40.0,
    dpi = DPI,
    language = PrinterLanguage.ZPL,
    elements = listOf(
        LabelElement.Barcode(
            id = "code",
            xMm = 4.0,
            yMm = 5.0,
            format = format,
            data = source,
            sizeMm = 20.0,
        ),
    ),
)

class DataMatrixEmitTest {
    private val duplicate = spec(BarcodeFormat.DATAMATRIX, BarcodeSource.Field(LabelField.KM_CODE))
    private val data = mapOf(LabelField.KM_CODE to RAW)

    @Test
    fun zplFramesTheSymbolAsAGraphicAtTheElementOrigin() = runBlocking {
        val raster = rasterizeGs1DataMatrix(RAW, mmToDots(20.0, DPI))
        val expected = "^FO${mmToDots(4.0, DPI)},${mmToDots(5.0, DPI)}" +
            "^GFA,${raster.totalBytes},${raster.totalBytes},${raster.bytesPerRow},${raster.hex}^FS"
        assertTrue(generateZpl(duplicate, data, null).contains(expected))
    }

    @Test
    fun tsplFramesTheSymbolAsABitmapAtTheElementOrigin() = runBlocking {
        val raster = rasterizeGs1DataMatrix(RAW, mmToDots(20.0, DPI))
        val document = String(generateTspl(duplicate, data, null), Charsets.ISO_8859_1)
        val header = "BITMAP ${mmToDots(4.0, DPI)},${mmToDots(5.0, DPI)},${raster.bytesPerRow},${raster.height},0,"
        assertTrue(document.contains(header))
        val payload = document.substringAfter(header).take(raster.totalBytes)
        assertEquals(String(tsplBitmapBytes(raster.hex), Charsets.ISO_8859_1), payload)
    }

    /**
     * An empty marking code is a template or data bug. Printing it blank would
     * put a scannable symbol carrying nothing but the GS1 flag on a product.
     */
    @Test
    fun anEmptyMarkingCodeIsARenderFailure() {
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(duplicate, emptyMap(), null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(duplicate, emptyMap(), null) }
        }
    }

    /** Only `km.code` gets the GS1 treatment; a literal Data Matrix stays unsupported. */
    @Test
    fun aDataMatrixBoundToALiteralIsStillRefused() {
        val literal = spec(BarcodeFormat.DATAMATRIX, BarcodeSource.Literal("hello"))
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(literal, data, null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(literal, data, null) }
        }
    }

    @Test
    fun otherBarcodeFormatsAreStillRefused() {
        val qr = spec(BarcodeFormat.QR, BarcodeSource.Field(LabelField.KM_CODE))
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(qr, data, null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(qr, data, null) }
        }
    }
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DataMatrixEmitTest*'`
Expected: FAIL — `LabelRenderException: barcode format datamatrix is not supported on this device`.

- [ ] **Step 8: Add the raster branch to the ZPL emitter**

In `app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt`, add the import:

```kotlin
import app.markiro.handheld.core.barcode.rasterizeGs1DataMatrix
```

and replace the whole `private fun barcode(...)` function with:

```kotlin
private fun barcode(spec: LabelSpec, element: LabelElement.Barcode, data: Map<LabelField, String>): String {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val source = element.data
    // The only Data Matrix this device prints is the marking code, and it prints
    // as a bitmap rather than the printer's own ^BX: the other language has no
    // way to carry FNC1 at all, and a duplicate that is a plain Data Matrix
    // instead of a GS1 one is a wrong code on a product. Keeping both languages
    // on one path also means a template cannot print differently by printer brand.
    if (element.format == BarcodeFormat.DATAMATRIX &&
        source is BarcodeSource.Field &&
        source.field == LabelField.KM_CODE
    ) {
        val raw = data[LabelField.KM_CODE].orEmpty()
        if (raw.isEmpty()) throw LabelRenderException("no marking code to print")
        // Unlike every other barcode element, `sizeMm` here is the whole symbol
        // square rather than a module width.
        return "^FO$x,$y${buildGfaCommand(rasterizeGs1DataMatrix(raw, mmToDots(element.sizeMm, spec.dpi)))}^FS"
    }
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val value = when (source) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    // The application identifier is added here and nowhere else: storage and transport carry a bare
    // eighteen-digit code. `>;` selects subset C and `>8` is the printer's own GS1 flag.
    val gs1 = source is BarcodeSource.Field && source.field == LabelField.SSCC
    val payload = if (gs1) ">;>800$value" else value
    // The bar-width command is modal on a real printer and survives into the next label, so it is
    // pinned immediately before its own barcode rather than set once per document.
    val barWidth = element.moduleWidthMm?.let { "^BY${max(1, min(10, mmToDots(it, spec.dpi)))}" } ?: ""
    val (fh, escaped) = escapeFieldData(payload)
    // The interpretation line is off on purpose, matching the other language, so one template does
    // not print differently depending on the printer brand.
    return "^FO$x,$y$barWidth^BCN,${mmToDots(element.sizeMm, spec.dpi)},N,N,N$fh^FD$escaped^FS"
}
```

- [ ] **Step 9: Add the raster branch to the TSPL emitter**

In `app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt`, add the import:

```kotlin
import app.markiro.handheld.core.barcode.rasterizeGs1DataMatrix
```

Change the dispatch line inside `generateTspl` from:

```kotlin
            is LabelElement.Barcode -> line(barcode(spec, element, data))
```

to:

```kotlin
            is LabelElement.Barcode -> barcode(spec, element, data, out, ::line)
```

and replace the whole `private fun barcode(...)` function with:

```kotlin
private fun barcode(
    spec: LabelSpec,
    element: LabelElement.Barcode,
    data: Map<LabelField, String>,
    out: ByteArrayOutputStream,
    line: (String) -> Unit,
) {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val source = element.data
    // This language's own DMATRIX carries no FNC1, so a native symbol would be a
    // plain Data Matrix rather than a GS1 one. The bitmap is the only correct form,
    // and it is the same bitmap the other language sends.
    if (element.format == BarcodeFormat.DATAMATRIX &&
        source is BarcodeSource.Field &&
        source.field == LabelField.KM_CODE
    ) {
        val raw = data[LabelField.KM_CODE].orEmpty()
        if (raw.isEmpty()) throw LabelRenderException("no marking code to print")
        // Unlike every other barcode element, `sizeMm` here is the whole symbol
        // square rather than a module width.
        buildBitmapCommand(x, y, rasterizeGs1DataMatrix(raw, mmToDots(element.sizeMm, spec.dpi)), out)
        out.write('\n'.code)
        return
    }
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val value = when (source) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    val gs1 = source is BarcodeSource.Field && source.field == LabelField.SSCC
    // `!1` is this language's GS1 flag and `00` is the application identifier, added here and
    // nowhere else.
    val payload = if (gs1) "!100$value" else value
    val narrow = element.moduleWidthMm?.let { max(1, mmToDots(it, spec.dpi)) } ?: DEFAULT_NARROW_DOTS
    // The interpretation line is off, matching the other language.
    line("BARCODE $x,$y,\"128\",${mmToDots(element.sizeMm, spec.dpi)},0,0,$narrow,$narrow,\"${escape(payload)}\"")
}
```

- [ ] **Step 10: Correct the size unit's documentation**

In `app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpec.kt`, replace the doc comment on `LabelElement.Barcode.sizeMm`:

```kotlin
        /**
         * Height for code128 and ean13; the module square side for qr. For the
         * marking-code Data Matrix it is the WHOLE symbol square, quiet zone
         * included -- that is the convention a duplicate template is authored to.
         */
        val sizeMm: Double,
```

- [ ] **Step 11: Run the emitter test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DataMatrixEmitTest*'`
Expected: PASS, 5 tests.

- [ ] **Step 12: Run the surrounding suites to prove nothing regressed**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*core.label.*' --tests '*core.box.*'`
Expected: PASS. `LabelFixturesTest`, `ZplEmitterTest`, `TsplEmitterTest` and `BoxPrinterTest` are what the emitter rewrite could break; the shared fixtures contain no Data Matrix case, so every byte-identical assertion must still hold untouched.

- [ ] **Step 13: Run the full gates**

Run: `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`
Expected: BUILD SUCCESSFUL. If `lintDebug` reports a newer ZXing version is available, report it rather than suppressing it; the catalog pins exact versions deliberately.

- [ ] **Step 14: Document the capability**

In `apps/handheld/README.md`, find the section describing printing and the label stack, and add after the paragraph that lists what the stack supports:

```markdown
The label stack renders a GS1 Data Matrix for the `km.code` field as a bitmap
(`core/barcode/`), never as the printer's own Data Matrix command: TSPL's
`DMATRIX` cannot carry the FNC1 flag, so a natively printed symbol would be a
plain Data Matrix rather than a GS1 one. Symbol sizing, error correction and
module placement come from ZXing; the GS1 codeword framing is ours, because no
library provides it. For that element, and only that element, a template's
`sizeMm` is the whole symbol square rather than a module width.

The encoder is deliberately not byte-pinned to `packages/domain`, which encodes
through bwip-js: nothing ever compares one device's label bytes with another's,
so the contract is that the printed symbol decodes to the right payload.
`DataMatrixTest` asserts exactly that, by decoding it.
```

- [ ] **Step 15: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/label/ZplEmitter.kt app/src/main/kotlin/app/markiro/handheld/core/label/TsplEmitter.kt app/src/main/kotlin/app/markiro/handheld/core/label/LabelSpec.kt app/src/test/kotlin/app/markiro/handheld/core/label/DataMatrixEmitTest.kt README.md
git commit -m "feat(handheld): print a GS1 Data Matrix in both printer languages"
```

---

## What this plan does not prove

State these plainly in the pull request; do not let a green suite imply them.

- **That a printed symbol scans.** Every check here decodes a symbol in memory. Print quality, contrast and module size against a real print head and a real scanner's optics are unverified, and the module size a template chooses is exactly where this goes wrong in the field.
- **Parity with the station's label.** Deliberate — see the global constraints. The two devices may produce different symbol sizes for the same code, and both are correct.
- **Bluetooth.** Unchanged by this slice and still unverifiable on an emulator.
