package app.markiro.handheld.core.km

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KmFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("km-fixtures.json")) { "run pnpm --filter @markiro/domain fixtures:km" }
            .readText(),
    ).jsonObject

    @Test
    fun parseFixturesMatchTheDomainPackage() {
        val cases = fixtures.getValue("parse").jsonArray
        assertTrue(cases.size >= 35)
        for (case in cases) {
            val name = case.jsonObject.getValue("name").jsonPrimitive.content
            val raw = case.jsonObject.getValue("raw").jsonPrimitive.content
            val expected = case.jsonObject.getValue("expected").jsonObject
            val error = expected["error"]?.jsonPrimitive?.content
            if (error != null) {
                val thrown = runCatching { KmCodec.canonicalize(raw) }.exceptionOrNull()
                assertTrue("$name: expected $error, got ${thrown ?: "success"}", thrown is KmException)
                assertEquals(name, error, (thrown as KmException).code)
            } else {
                val km = KmCodec.canonicalize(raw)
                assertEquals(name, expected.getValue("canonicalRaw").jsonPrimitive.content, km.canonicalRaw)
                assertEquals(name, expected.getValue("gtin14").jsonPrimitive.content, km.gtin14)
                assertEquals(name, expected.getValue("serial").jsonPrimitive.content, km.serial)
                assertEquals(name, expected.getValue("ais").jsonObject.mapValues { it.value.jsonPrimitive.content }, km.ais)
                assertEquals(name, expected.getValue("key").jsonPrimitive.content, KmCodec.key(km))
                assertEquals(name, expected.getValue("hash").jsonPrimitive.content, KmCodec.hash(km))
            }
        }
    }

    @Test
    fun verdictFixturesFollowTheDomainOrder() {
        val cases = fixtures.getValue("verdict").jsonArray
        assertTrue(cases.size >= 8)
        for (case in cases) {
            val o = case.jsonObject
            val known = o.getValue("knownHashes").jsonArray.map { it.jsonPrimitive.content }.toSet()
            val verdict = ShiftValidator.verdict(
                o.getValue("raw").jsonPrimitive.content,
                o.getValue("expectedGtin14").jsonPrimitive.content,
            ) { it in known }
            assertEquals(o.getValue("name").jsonPrimitive.content, o.getValue("verdict").jsonPrimitive.content, verdict.wire)
        }
    }

    @Test
    fun hashIsSha256OfTheKey() {
        val km = KmCodec.canonicalize("010460068200001321x")
        assertEquals("0104600682000013" + "21x", KmCodec.key(km))
        assertEquals(64, KmCodec.hash(km).length)
        assertTrue(KmCodec.hash(km).all { it in '0'..'9' || it in 'a'..'f' })
    }
}
