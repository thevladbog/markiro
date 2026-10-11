package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StandardLabelCompatibilityTest {
    @Test
    fun standardQuantityAndSsccFormatsAreRecognized() {
        val spec = LabelSpecCodec.parse("""{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[{"id":"qty","kind":"field","field":"qty.boxes","textFormat":"quantity_number","xMm":4,"yMm":56,"fontSizePt":30,"lineHeight":1},{"id":"sscc","kind":"field","field":"sscc","textFormat":"sscc_with_title","xMm":4,"yMm":142,"fontSizePt":14,"fontFamily":"monospace","lineHeight":1}]}""")
        val qty = spec.elements[0] as LabelElement.Field
        val sscc = spec.elements[1] as LabelElement.Field
        assertEquals("120", labelFieldDisplayValue(qty.field, mapOf(LabelField.QTY_BOXES to "120"), qty.textFormat))
        assertEquals("SSCC  (00) 146000000000001231", labelFieldDisplayValue(sscc.field, mapOf(LabelField.SSCC to "146000000000001231"), sscc.textFormat))
    }
    @Test
    fun organizationLogoIsNotRejectedAsAnUnknownTemplate() = runTest {
        val spec = LabelSpecCodec.parse("""{"widthMm":75,"heightMm":120,"dpi":203,"language":"zpl","elements":[{"id":"logo","kind":"organization_logo","source":"organization","fallback":"markiro","xMm":4,"yMm":3,"widthMm":30,"heightMm":7}]}""")
        assertEquals(1, spec.elements.size)
        try {
            generateZpl(spec, emptyMap(), null)
            throw AssertionError("Logo must be supplied, never silently omitted")
        } catch (e: LabelRenderException) { assertTrue(e.message!!.contains("logo", ignoreCase = true)) }
    }
}
