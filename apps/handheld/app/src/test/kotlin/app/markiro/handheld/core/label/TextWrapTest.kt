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
        assertEquals(listOf("ab", "cd"), wrapTextToWidth("  ab   cd  ", perChar, 2.0, 4))
    }

    @Test
    fun aNoBreakSpaceCountsAsWhitespaceAsItDoesInJavaScript() {
        // Java's default whitespace class excludes both of these characters and JavaScript's
        // includes them, so the class is spelled out. A product name carrying a no-break space
        // has to wrap the same way on both sides or the two would disagree about line count.
        assertEquals(listOf("ab", "cd"), wrapTextToWidth("ab cd", perChar, 2.0, 4))
        assertEquals(listOf("ab", "cd"), wrapTextToWidth("ab﻿cd", perChar, 2.0, 4))
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
