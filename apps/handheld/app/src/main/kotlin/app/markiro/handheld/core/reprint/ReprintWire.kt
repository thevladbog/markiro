package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.duplicate.parseDuplicateKm
import app.markiro.handheld.core.duplicate.productLabelBytesDigest
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.km.KmCodec
import kotlinx.serialization.json.*
import java.io.IOException

internal fun JsonObject.string(key: String): String = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw IOException("invalid reprint response")
internal fun JsonObject.optionalString(key: String): String? = get(key)?.takeUnless { it is JsonNull }?.let { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content ?: throw IOException("invalid reprint response") }
internal fun JsonObject.number(key: String): Int = (get(key) as? JsonPrimitive)?.intOrNull ?: throw IOException("invalid reprint response")
internal fun reprintObject(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

/** The domain's sorted-key JSON digest. Numbers here originate in the original server JSON. */
internal fun reprintDigest(value: JsonElement): String {
    fun canonical(element: JsonElement): String = when (element) {
        is JsonObject -> element.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(element.getValue(it)) }
        is JsonArray -> element.joinToString(",", "[", "]") { canonical(it) }
        else -> element.toString()
    }
    return productLabelBytesDigest(canonical(value).toByteArray(Charsets.UTF_8))
}
/** Exact warehouse-only repair from the shared domain; never use for physical verification. */
fun siteReprintSscc(raw: String): String? {
    val trimmed = raw.trim()
    val legacy = Regex("^(?:\\]C[01])?!100([0-9]{18})$").matchEntire(trimmed)?.groupValues?.get(1)
    if (legacy != null) return ScanClassifier.parseSscc(legacy)
    if (Regex("^(?:\\]C[01])?!1").containsMatchIn(trimmed)) return null
    return ScanClassifier.parseSscc(trimmed)
}
internal fun validateSourceIdentity(raw: String, source: SiteReprintSource) {
    require(source.kind in setOf("unit", "box", "pallet"))
    if (source.kind == "unit") {
        val returned = parseDuplicateKm(source.fields.getValue("km.code"))
        require(returned.canonicalRaw == parseDuplicateKm(raw).canonicalRaw)
        require(KmCodec.hash(returned) == source.identity)
        require(source.fields["sscc"].orEmpty().isEmpty())
        require(returned.gtin14 == source.fields["product.gtin"])
    } else {
        require(siteReprintSscc(raw) == source.identity)
        require(source.fields["sscc"] == source.identity)
        require(source.fields["km.code"].orEmpty().isEmpty())
    }
}
internal fun noOpEnvelope(backend: String, input: SiteReprintAuditInput): String = buildJsonObject {
    put("backend", backend); put("localOnly", true); put("recordId", input.recordId)
    put("jobId", input.jobId); put("attemptId", input.attemptId); put("sequence", input.sequence)
    put("outcome", input.outcome)
}.toString()
internal fun checkedReceipt(response: JsonObject, idKey: String, id: String, revision: Pair<String,String>? = null): SiteReprintReceipt {
    val rows = response["results"]?.jsonArray ?: throw IOException("reprint receipt missing")
    val row = rows.singleOrNull()?.jsonObject ?: throw IOException("reprint receipt mismatch")
    if (row.string(idKey) != id || (revision != null && row.string(revision.first) != revision.second)) throw IOException("reprint receipt mismatch")
    return when (row.string("status")) {
        "accepted" -> SiteReprintReceipt.Accepted
        "conflict" -> SiteReprintReceipt.Rejected("conflict")
        "retryable" -> throw IOException("reprint receipt retryable")
        else -> throw IOException("reprint receipt invalid")
    }
}
