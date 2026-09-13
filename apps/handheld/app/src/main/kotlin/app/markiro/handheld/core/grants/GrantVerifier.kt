package app.markiro.handheld.core.grants

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.AlgorithmParameters
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECParameterSpec
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class VerificationKey(val kid: String, val origin: String, val spkiDer: ByteArray)
enum class VerificationReason { MALFORMED, BAD_SIGNATURE, UNKNOWN_KEY, WRONG_ORIGIN }
sealed interface VerifiedGrantResult {
    data class Valid(val grant: OfflineGrant, val compact: String) : VerifiedGrantResult
    data class Invalid(val reason: VerificationReason) : VerifiedGrantResult
}

class GrantVerifier(private val keys: List<VerificationKey>) {
    /** Only for locally persisted tokens already verified by the installation boundary. No crypto in Room commits. */
    internal fun parseStored(compact: String): OfflineGrant = parseCompact(compact).grant

    fun verify(compact: String, ownerOrigin: String): VerifiedGrantResult {
        val parsed = try { parseCompact(compact) } catch (_: Exception) { return VerifiedGrantResult.Invalid(VerificationReason.MALFORMED) }
        if (parsed.signature.size != 64) return VerifiedGrantResult.Invalid(VerificationReason.BAD_SIGNATURE)
        if (parsed.grant.issuer != ownerOrigin || !isCanonicalOrigin(ownerOrigin)) return VerifiedGrantResult.Invalid(VerificationReason.WRONG_ORIGIN)
        val named = keys.filter { it.kid == parsed.kid }
        if (named.isEmpty()) return VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY)
        val matching = named.filter { it.origin == ownerOrigin }
        if (matching.isEmpty()) return VerifiedGrantResult.Invalid(VerificationReason.WRONG_ORIGIN)
        if (matching.size != 1) return VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY)
        val publicKey = try {
            KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(matching.single().spkiDer))
        } catch (_: Exception) { return VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY) }
        if (publicKey !is ECPublicKey || !isP256(publicKey.params)) return VerifiedGrantResult.Invalid(VerificationReason.UNKNOWN_KEY)
        val valid = try {
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(publicKey)
                update(parsed.signingInput)
                verify(rawSignatureToDer(parsed.signature))
            }
        } catch (_: Exception) { return VerifiedGrantResult.Invalid(VerificationReason.BAD_SIGNATURE) }
        return if (valid) VerifiedGrantResult.Valid(parsed.grant, compact) else VerifiedGrantResult.Invalid(VerificationReason.BAD_SIGNATURE)
    }

    private data class Parsed(val kid: String, val grant: OfflineGrant, val signature: ByteArray, val signingInput: ByteArray)
    private fun parseCompact(compact: String): Parsed {
        val segments = compact.split('.', limit = 4)
        require(segments.size == 3 && segments.all { it.isNotEmpty() })
        val header = parseObject(decode(segments[0]))
        require(header.keys == setOf("typ", "alg", "kid"))
        require(header.string("typ") == "markiro-offline-grant+jws" && header.string("alg") == "ES256")
        val kid = header.string("kid").also { require(it.isNotEmpty()) }
        val grant = parseGrant(parseObject(decode(segments[1])))
        return Parsed(kid, grant, decode(segments[2]), "${segments[0]}.${segments[1]}".toByteArray(StandardCharsets.US_ASCII))
    }

    private fun decode(segment: String): ByteArray {
        require(segment.matches(Regex("^[A-Za-z0-9_-]+$")) && segment.length % 4 != 1)
        val bytes = Base64.getUrlDecoder().decode(segment)
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == segment)
        return bytes
    }

    private fun parseObject(bytes: ByteArray): JsonObject {
        val text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        return Json.parseToJsonElement(text).jsonObject
    }

    private fun parseGrant(o: JsonObject): OfflineGrant {
        val common = setOf("tenantId", "deviceId", "kind", "credentialEpoch", "version", "issuer", "grantId", "entitlementRevision", "policyRevision", "issuedAt", "notBefore", "kindOfGrant")
        val kindOfGrant = o.string("kindOfGrant")
        val expected = common + if (kindOfGrant == "device") setOf("startNotAfter", "capabilities") else if (kindOfGrant == "task") setOf("taskKind", "taskId", "snapshotDigest", "completeNotAfter", "eventTypes", "budget") else error("kind")
        require(o.keys == expected && o.long("version") == 1L)
        val owner = GrantOwner(o.nonempty("tenantId"), o.nonempty("deviceId"), enumValue(o.string("kind"), DeviceKind.entries), o.positive("credentialEpoch"))
        val issuer = o.nonempty("issuer"); val grantId = o.nonempty("grantId"); val entitlement = o.nonempty("entitlementRevision"); val policy = o.nonempty("policyRevision")
        val issuedAt = o.safeLong("issuedAt"); val notBefore = o.safeLong("notBefore")
        return if (kindOfGrant == "device") {
            val deadline = o.safeLong("startNotAfter")
            val capabilities = o.array("capabilities").map { enumValue((it as JsonPrimitive).content, GrantCapability.entries) }
            require(capabilities.isNotEmpty() && capabilities.distinct().size == capabilities.size && issuedAt <= notBefore && notBefore < deadline)
            require(capabilities.all { if (owner.kind == DeviceKind.KIOSK) it == GrantCapability.PICKUP_START else it != GrantCapability.PICKUP_START })
            DeviceGrant(owner, issuer, grantId, entitlement, policy, issuedAt, notBefore, deadline, capabilities.toSet())
        } else {
            val taskKind = enumValue(o.string("taskKind"), TaskKind.entries); val deadline = o.safeLong("completeNotAfter")
            val events = o.array("eventTypes").map { enumValue((it as JsonPrimitive).content, GrantEventType.entries) }
            val budget = o.array("budget").map { element ->
                val line = element.jsonObject; require(line.keys == setOf("id", "unit", "maximum"))
                BudgetLine(line.nonempty("id"), enumValue(line.string("unit"), BudgetUnit.entries), line.safeLong("maximum"))
            }
            require(events.isNotEmpty() && events.distinct().size == events.size && budget.isNotEmpty() && budget.map { it.id }.distinct().size == budget.size)
            require(issuedAt <= notBefore && notBefore < deadline && (owner.kind == DeviceKind.KIOSK) == (taskKind == TaskKind.PICKUP) && events.all { it.wire.startsWith("${taskKind.wire}.") })
            TaskGrant(owner, issuer, grantId, entitlement, policy, issuedAt, notBefore, taskKind, o.nonempty("taskId"), o.nonempty("snapshotDigest"), deadline, events.toSet(), budget)
        }
    }

    private fun isCanonicalOrigin(value: String): Boolean {
        val url = value.toHttpUrlOrNull() ?: return false
        if (url.scheme != "http" && url.scheme != "https") return false
        if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.encodedPath != "/" || url.query != null || url.fragment != null) return false
        val canonical = url.toUrl().let { "${it.protocol}://${it.authority}" }
        return canonical == value
    }

    private fun isP256(actual: ECParameterSpec): Boolean {
        val parameters = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        val expected = parameters.getParameterSpec(ECParameterSpec::class.java)
        return actual.curve == expected.curve && actual.generator == expected.generator && actual.order == expected.order && actual.cofactor == expected.cofactor
    }

    private fun rawSignatureToDer(raw: ByteArray): ByteArray {
        fun integer(bytes: ByteArray): ByteArray {
            var first = 0
            while (first < bytes.lastIndex && bytes[first] == 0.toByte()) first++
            val value = bytes.copyOfRange(first, bytes.size)
            val positive = if (value[0].toInt() and 0x80 != 0) byteArrayOf(0) + value else value
            return byteArrayOf(0x02, positive.size.toByte()) + positive
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}

private fun JsonObject.string(name: String): String = (getValue(name) as JsonPrimitive).also { require(it.isString) }.content
private fun JsonObject.nonempty(name: String): String = string(name).also { require(it.isNotEmpty()) }
private fun JsonObject.long(name: String): Long = (getValue(name) as JsonPrimitive).run {
    require(!isString)
    val number = content.toDoubleOrNull()
    require(number != null && number.isFinite() && number >= 0.0 && number <= JS_MAX_SAFE_INTEGER.toDouble() && number % 1.0 == 0.0)
    number.toLong()
}
private fun JsonObject.safeLong(name: String): Long = long(name).also { require(safe(it)) }
private fun JsonObject.positive(name: String): Long = safeLong(name).also { require(it > 0) }
private fun JsonObject.array(name: String): JsonArray = getValue(name) as JsonArray
private fun <T> enumValue(wire: String, entries: List<T>): T where T : Enum<T> = entries.single { (it as? DeviceKind)?.wire == wire || (it as? GrantCapability)?.wire == wire || (it as? GrantEventType)?.wire == wire || (it as? TaskKind)?.wire == wire || (it as? BudgetUnit)?.wire == wire }
