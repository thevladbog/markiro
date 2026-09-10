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

    /** Ten units per character, so the expectations below are arithmetic rather than typography. */
    private val tenPerChar: (String) -> Double = { it.length * 10.0 }

    @Test
    fun theBitmapNeverExceedsItsBoxAndClipsWhatWillNotFit() {
        val layout = rasterLayout(
            "Очень длинное наименование товара",
            RasterOptions("sans-serif", fontSizePx = 20, bold = false, maxWidthPx = 120, maxLines = 2),
            tenPerChar,
        )
        assertEquals(2, layout.lines.size)
        assertTrue(layout.lines.last().endsWith("…"))
        assertTrue(layout.width <= 120)
        // Two lines in a box one and a half times the font size.
        assertEquals(60, layout.height)
    }

    @Test
    fun anUnboundedRunTakesItsNaturalWidthOnOneLine() {
        val layout = rasterLayout("Вода", RasterOptions("sans-serif", 20, false, null, 1), tenPerChar)
        assertEquals(listOf("Вода"), layout.lines)
        assertEquals(40, layout.width)
        assertEquals(30, layout.height)
    }

    @Test
    fun anEmptyRunStillHasABitmap() {
        val layout = rasterLayout("", RasterOptions("sans-serif", 20, false, null, 1), tenPerChar)
        assertEquals(1, layout.width)
        assertEquals(30, layout.height)
    }

    @Test
    fun thePackingMatchesTheBitmapItDescribes() = runTest {
        val result = rasterizer.rasterize("Вода", RasterOptions("sans-serif", 20, false, null, 1))
        assertEquals(30, result.height)
        assertEquals((result.width + 7) / 8, result.bytesPerRow)
        assertEquals(result.bytesPerRow * result.height, result.totalBytes)
        assertEquals(result.totalBytes * 2, result.hex.length)
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
