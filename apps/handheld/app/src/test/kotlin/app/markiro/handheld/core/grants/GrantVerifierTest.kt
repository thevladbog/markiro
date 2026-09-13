package app.markiro.handheld.core.grants

import java.util.Base64
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GrantVerifierTest {
    private val fixture = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResourceAsStream("offline-grants-v1.json"))
            .bufferedReader().use { it.readText() },
    ).jsonObject
    private val origin = "https://offline-grants.fixture.invalid"
    private val key = VerificationKey(
        kid = fixture.getValue("publicKey").jsonObject.getValue("kid").jsonPrimitive.content,
        origin = origin,
        spkiDer = Base64.getDecoder().decode(
            fixture.getValue("publicKey").jsonObject.getValue("spkiDerBase64").jsonPrimitive.content,
        ),
    )

    @Test fun `matches every shared verification vector using original compact bytes`() {
        val failures = mapOf(
            "unsupported_algorithm" to VerificationReason.MALFORMED,
            "invalid_header" to VerificationReason.MALFORMED,
            "malformed_compact" to VerificationReason.MALFORMED,
            "invalid_signature" to VerificationReason.BAD_SIGNATURE,
            "unknown_key" to VerificationReason.UNKNOWN_KEY,
            "issuer_mismatch" to VerificationReason.WRONG_ORIGIN,
        )
        val verifier = GrantVerifier(listOf(key))
        val vectors = fixture.getValue("vectors").jsonArray
        assertEquals(39, vectors.size)
        vectors.forEach { element ->
            val vector = element.jsonObject
            val input = vector.getValue("input").jsonObject
            val expected = vector.getValue("expected").jsonObject
            val result = verifier.verify(
                input.getValue("compact").jsonPrimitive.content,
                input.getValue("context").jsonObject.getValue("issuer").jsonPrimitive.content,
            )
            val reason = failures[expected.getValue("admission").jsonPrimitive.content]
            if (reason == null) {
                assertTrue(vector.getValue("id").jsonPrimitive.content, result is VerifiedGrantResult.Valid)
                assertEquals(input.getValue("compact").jsonPrimitive.content, (result as VerifiedGrantResult.Valid).compact)
            } else {
                assertEquals(vector.getValue("id").jsonPrimitive.content, VerifiedGrantResult.Invalid(reason), result)
            }
        }
    }

    @Test fun `rejects a non P-256 EC subject public key as unknown`() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp384r1"))
        val p384 = key.copy(spkiDer = generator.generateKeyPair().public.encoded)
        val compact = fixture.getValue("producers").jsonArray.first { it.jsonObject.getValue("id").jsonPrimitive.content == "device" }.jsonObject.getValue("compact").jsonPrimitive.content
        assertEquals(VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY), GrantVerifier(listOf(p384)).verify(compact, origin))
    }

    @Test fun `rejects unsafe numeric and unknown signed payload fields before signature admission`() {
        val producer = fixture.getValue("producers").jsonArray.first { it.jsonObject.getValue("id").jsonPrimitive.content == "device" }.jsonObject
        val parts = producer.getValue("compact").jsonPrimitive.content.split('.')
        val original = Json.parseToJsonElement(producer.getValue("payloadJson").jsonPrimitive.content).jsonObject
        val payloads = listOf(
            buildJsonObject { original.forEach { (name, value) -> put(name, value) }; put("credentialEpoch", 0) },
            buildJsonObject { original.forEach { (name, value) -> put(name, value) }; put("startNotAfter", JS_MAX_SAFE_INTEGER + 1) },
            buildJsonObject { original.forEach { (name, value) -> put(name, value) }; put("surprise", true) },
        )
        payloads.forEach { payload ->
            val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toString().toByteArray())
            assertEquals(VerifiedGrantResult.Invalid(VerificationReason.MALFORMED), GrantVerifier(listOf(key)).verify("${parts[0]}.$encoded.${parts[2]}", origin))
        }
    }

    @Test fun `binds a unique public key to its configured origin`() {
        val compact = fixture.getValue("producers").jsonArray.first { it.jsonObject.getValue("id").jsonPrimitive.content == "device" }.jsonObject.getValue("compact").jsonPrimitive.content
        assertEquals(VerifiedGrantResult.Invalid(VerificationReason.WRONG_ORIGIN), GrantVerifier(listOf(key.copy(origin = "https://other.invalid"))).verify(compact, origin))
        assertEquals(VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY), GrantVerifier(listOf(key, key)).verify(compact, origin))
    }

    @Test fun `noncanonical equal issuer and key origin reaches origin canonicality guard`() {
        val producer = fixture.getValue("producers").jsonArray.first { it.jsonObject.getValue("id").jsonPrimitive.content == "device" }.jsonObject
        val parts = producer.getValue("compact").jsonPrimitive.content.split('.')
        val original = Json.parseToJsonElement(producer.getValue("payloadJson").jsonPrimitive.content).jsonObject
        val badOrigin = origin + "/"
        val payload = buildJsonObject { original.forEach { (name,value) -> put(name,value) }; put("issuer",badOrigin) }
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toString().toByteArray())
        assertEquals(VerifiedGrantResult.Invalid(VerificationReason.WRONG_ORIGIN), GrantVerifier(listOf(key.copy(origin=badOrigin))).verify("${parts[0]}.$encoded.${parts[2]}",badOrigin))
    }
}
