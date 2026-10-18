package app.markiro.handheld.core.label

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The label layouts of the host are the domain's (`labelTemplateSpecSchema`), so the app's codec reads them
 * (plan ТСД-А, task С1; spec 7.2, risk Р-11): every template of the host's feed fixtures and of the wizard's
 * stock templates is read, and the layout survives with the geometry and the element kinds it had.
 */
class HostLabelSpecParityTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText(),
    ).jsonObject

    @Test
    fun everyTemplateOfTheHostsFeedIsReadByTheAppsCodec() {
        val specs = fixture("changes-catalog.json").getValue("items").jsonArray
            .map { it.jsonObject }
            .filter { it.getValue("entity").jsonPrimitive.content == "label_templates" && it["data"] != null }
            .map { it.getValue("data").jsonObject.getValue("spec").jsonObject }
        assertTrue(specs.size >= 2)
        for (spec in specs) {
            val read = LabelSpecCodec.spec(spec)
            assertEquals(spec.getValue("widthMm").jsonPrimitive.content.toDouble(), read.widthMm, 0.0)
            assertEquals(spec.getValue("dpi").jsonPrimitive.content.toInt(), read.dpi)
            assertEquals(spec.getValue("elements").jsonArray.size, read.elements.size)
        }
    }

    @Test
    fun theWizardsStockTemplatesAreReadToo() {
        val templates = fixture("bootstrap-request-templates.json").getValue("templates").jsonArray
        assertTrue(templates.isNotEmpty())
        for (template in templates) {
            val spec = template.jsonObject.getValue("spec").jsonObject
            val read = LabelSpecCodec.spec(spec)
            assertEquals(spec.getValue("elements").jsonArray.size, read.elements.size)
        }
    }
}
