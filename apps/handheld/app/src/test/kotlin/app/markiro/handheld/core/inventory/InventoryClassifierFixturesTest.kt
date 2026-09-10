package app.markiro.handheld.core.inventory

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InventoryClassifierFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("inventory-fixtures.json")) { "run pnpm --filter @markiro/domain fixtures:inventory" }
            .readText(),
    ).jsonObject

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.strOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private fun row(o: JsonObject) = SnapshotRow(
        codeHash = o.str("codeHash"), canonicalRaw = o.str("canonicalRaw"), gtin14 = o.str("gtin14"), serial = o.str("serial"),
        sourceStatus = o.str("sourceStatus"), sourceState = o.strOrNull("sourceState"), sourceProductionDate = o.strOrNull("sourceProductionDate"),
        expected = o.getValue("expected").jsonPrimitive.booleanOrNull == true, protected = o.getValue("protected").jsonPrimitive.booleanOrNull == true,
        parentSscc = o.strOrNull("parentSscc"),
    )

    private fun claim(o: JsonObject) = LocalClaim(o.str("codeHash"), o.str("eventId"), o.str("deviceId"), o.str("scannedAt"))

    private fun context(case: JsonObject): ClassifierContext {
        val rows = case.getValue("rows").jsonArray.map { row(it.jsonObject) }
        val claims = case.getValue("claims").jsonArray.map { claim(it.jsonObject) }.associateBy { it.codeHash }
        return object : ClassifierContext {
            override val taskGtin14 = case.str("taskGtin14")
            override fun snapshotCode(codeHash: String) = rows.firstOrNull { it.codeHash == codeHash }
            override fun snapshotChildren(sscc: String) = rows.filter { it.parentSscc == sscc }
            override fun localClaim(codeHash: String) = claims[codeHash]
        }
    }

    @Test
    fun classificationsMatchTheDomainPackage() {
        val cases = fixtures.getValue("classify").jsonArray
        assertTrue(cases.size >= 20)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val expected = case.getValue("expected").jsonObject
            val ctx = context(case)
            val actual = InventoryClassifier.classify(case.str("raw"), ctx)
            assertEquals(name, expected.str("kind"), actual.kind)
            if (actual is InventoryClassification.Invalid) {
                assertEquals(name, expected.str("reason"), actual.reason)
            } else {
                val identity = actual.identity
                assertEquals(name, expected.str("scanKind"), identity.scanKind)
                when (identity) {
                    is Identity.Item -> {
                        assertEquals(name, expected.str("codeHash"), identity.codeHash)
                        assertEquals(name, expected.str("canonicalRaw"), identity.canonicalRaw)
                        assertEquals(name, expected.str("serial"), identity.serial)
                    }
                    is Identity.KnownBox -> {
                        assertEquals(name, expected.str("sscc"), identity.sscc)
                        val children = expected.getValue("children").jsonArray.map { it.jsonObject }
                        assertEquals(name, children.map { it.str("codeHash") }, identity.children.map { it.codeHash })
                        assertEquals(name, children.map { it.str("originClassification") }, identity.children.map { it.origin.wire })
                        assertEquals(
                            name,
                            children.map { it["firstWinning"]?.takeIf { w -> w !is JsonNull }?.jsonObject?.str("eventId") },
                            identity.children.map { it.firstWinning?.eventId },
                        )
                    }
                    is Identity.OldBox -> assertEquals(name, expected.str("sscc"), identity.sscc)
                }
                if (actual is InventoryClassification.Duplicate) {
                    assertEquals(name, expected.getValue("firstWinning").jsonObject.str("eventId"), actual.firstWinning.eventId)
                }
                val status = expected.strOrNull("sourceStatus")
                if (status != null) assertEquals(name, status, actual.sourceStatus) else assertNull(name, actual.sourceStatus)
            }
            val date = case.getValue("sourceDate").jsonObject
            val source = InventoryClassifier.sourceDate(actual, ctx)
            assertEquals(name, date.str("kind"), source.kind)
            if (source is SourceDate.Single) {
                assertEquals(name, date.str("productionDate"), source.productionDate)
                assertEquals(name, date.str("scanKind"), source.scanKind)
            }
        }
    }

    @Test
    fun ssccWrappersAreStripped() {
        assertEquals("346006820000000014", ScanClassifier.parseSscc("]C100346006820000000014"))
        assertEquals("346006820000000014", ScanClassifier.parseSscc("(00)346006820000000014"))
        assertEquals("346006820000000014", ScanClassifier.parseSscc("00346006820000000014"))
        assertEquals(null, ScanClassifier.parseSscc("346006820000000015"))
        assertEquals(null, ScanClassifier.parseSscc("0".repeat(26)))
    }
}
