package app.markiro.handheld.core.duplicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin projection to `packages/domain`. The server validates the same
 * events, so a disagreement here is a batch the server quarantines -- which the
 * operator sees as labels that print and then never settle.
 *
 * Regenerate with `pnpm --filter @markiro/domain fixtures:product-labels`.
 */
class ProductLabelFixturesTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("product-label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:product-labels"
        }.readText(),
    ).jsonObject

    @Test
    fun everyProjectionCaseAgrees() {
        val cases = fixtures.getValue("projection").jsonArray
        assertTrue("expected the full case set, got ${cases.size}", cases.size >= 14)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val verification = case.getValue("verification").jsonPrimitive.content
            val events = case.getValue("events").jsonArray.map {
                json.decodeFromJsonElement(ProductLabelEvent.serializer(), it)
            }
            val invalidAt = case.getValue("invalidAt").let { if (it is JsonNull) null else it.jsonPrimitive.int }

            var projection: ProductLabelProjection? = null
            var refusedAt: Int? = null
            for ((index, event) in events.withIndex()) {
                try {
                    projection = applyProductLabelEvent(projection, event, verification)
                } catch (_: ProductLabelTransitionException) {
                    refusedAt = index
                    break
                }
            }
            assertEquals("$name: refusal index", invalidAt, refusedAt)

            val expected = case.getValue("projection")
            if (expected is JsonNull) {
                assertNull(name, projection)
                continue
            }
            val o = expected.jsonObject
            val p = checkNotNull(projection) { "$name: no projection" }
            assertEquals("$name: status", o.getValue("status").jsonPrimitive.content, p.status)
            assertEquals("$name: attemptState", o.getValue("attemptState").jsonPrimitive.content, p.attemptState)
            assertEquals(
                "$name: verificationOutcome",
                o.getValue("verificationOutcome").jsonPrimitive.content,
                p.verificationOutcome,
            )
            assertEquals("$name: attemptNo", o.getValue("attemptNo").jsonPrimitive.int, p.attemptNo)
            assertEquals("$name: latestSequence", o.getValue("latestSequence").jsonPrimitive.int, p.latestSequence)
            assertEquals("$name: attemptId", o.getValue("attemptId").jsonPrimitive.content, p.attemptId)
            assertEquals("$name: bytesDigest", o.getValue("bytesDigest").jsonPrimitive.content, p.bytesDigest)
            assertEquals("$name: language", o.getValue("language").jsonPrimitive.content, p.language)
            assertEquals("$name: dpi", o.getValue("dpi").jsonPrimitive.int, p.dpi)
        }
    }

    @Test
    fun theComparisonAgreesIncludingTheCryptoTail() {
        for (element in fixtures.getValue("compare").jsonArray) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val expected = when (case.getValue("result").jsonPrimitive.content) {
                "match" -> DuplicateMatch.MATCH
                "mismatch" -> DuplicateMatch.MISMATCH
                else -> DuplicateMatch.INVALID
            }
            assertEquals(
                name,
                expected,
                compareDuplicateKm(
                    case.getValue("expected").jsonPrimitive.content,
                    case.getValue("scanned").jsonPrimitive.content,
                ),
            )
        }
    }

    @Test
    fun thePayloadDigestAgrees() {
        for (element in fixtures.getValue("payloadDigest").jsonArray) {
            val case = element.jsonObject
            assertEquals(
                case.getValue("digest").jsonPrimitive.content,
                duplicatePayloadDigest(case.getValue("raw").jsonPrimitive.content),
            )
        }
    }

    /**
     * The identity hash and the duplicate comparison are two different functions
     * over one scan. Confusing them would accept a different unit of the same
     * product as a valid verification, which is the whole point of the check.
     */
    @Test
    fun theIdentityHashWouldHaveDisagreed() {
        val case = fixtures.getValue("compare").jsonArray
            .map { it.jsonObject }
            .single { it.getValue("name").jsonPrimitive.content.contains("crypto tail") }
        val expected = case.getValue("expected").jsonPrimitive.content
        val scanned = case.getValue("scanned").jsonPrimitive.content
        assertEquals(
            app.markiro.handheld.core.km.KmCodec.hash(app.markiro.handheld.core.km.KmCodec.canonicalize(expected)),
            app.markiro.handheld.core.km.KmCodec.hash(app.markiro.handheld.core.km.KmCodec.canonicalize(scanned)),
        )
        assertEquals(DuplicateMatch.INVALID, compareDuplicateKm(expected, scanned))
    }
}
