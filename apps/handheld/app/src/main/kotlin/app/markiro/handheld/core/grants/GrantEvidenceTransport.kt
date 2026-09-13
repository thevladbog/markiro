package app.markiro.handheld.core.grants

import app.markiro.handheld.core.inventory.CanonicalJson
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import kotlinx.serialization.json.*

/** Matches domain productLabelValueDigest: sorted UTF-16 object keys, original arrays/strings. Native numbers are safe integers. */
internal fun grantEvidenceCanonical(value: JsonElement): String = when (value) {
    is JsonObject -> value.toSortedMap().entries.joinToString(",", "{", "}") { evidenceString(it.key) + ":" + grantEvidenceCanonical(it.value) }
    is JsonArray -> value.joinToString(",", "[", "]", transform = ::grantEvidenceCanonical)
    JsonNull -> "null"
    is JsonPrimitive -> when {
        value.isString -> evidenceString(value.content)
        value.booleanOrNull != null -> value.content
        else -> checkNotNull(value.longOrNull).also { require(it in -JS_MAX_SAFE_INTEGER..JS_MAX_SAFE_INTEGER) }.toString()
    }
}

/** JSON.stringify escapes lone UTF-16 surrogates rather than replacing their bytes during UTF-8 encoding. */
private fun evidenceString(value: String): String {
    val encoded = CanonicalJson.str(value)
    return buildString {
        encoded.forEachIndexed { i, ch ->
            val paired = when {
                ch.isHighSurrogate() -> encoded.getOrNull(i + 1)?.isLowSurrogate() == true
                ch.isLowSurrogate() -> encoded.getOrNull(i - 1)?.isHighSurrogate() == true
                else -> true
            }
            if (paired) append(ch) else append("\\u").append(ch.code.toString(16).padStart(4, '0'))
        }
    }
}

internal data class EvidenceRequest(val key: String, val owner: String, val batchId: String, val path: String, val body: String, val negotiated: Boolean)

/** Durable original envelopes and authenticated receipts share the existing owner-sealed meta journal. */
internal class GrantEvidenceTransport(private val db: HandheldDatabase) {
    companion object {
        fun diagnosticKey(owner: String) = "grant_evidence_diagnostic:" + grantDigest(owner)
        const val SYNC_PROTOCOL = "sync_pending_grant_protocol"
        fun eventMarker(owner: String, event: String) = "grant_protocol:" + grantDigest(grantSlot(owner, "event", event))
    }

    suspend fun negotiated(event: String): Boolean {
        val owner = db.recovery.token().owner.grantOwnerKey()
        return db.grantDao().evidence(owner, event)?.compact != null || db.metaDao().get(eventMarker(owner, event)) == "offline-grants-v1"
    }

    suspend fun prepare(channel: String, batchId: String, legacyPath: String, payload: String, links: Map<String, String>, negotiated: Boolean): EvidenceRequest = db.recovery.commit {
        val owner = db.recovery.token().owner.grantOwnerKey()
        val key = "grant_transport:" + grantDigest(grantSlot(owner, channel, batchId))
        db.metaDao().get(key)?.let { saved ->
            val o = Json.parseToJsonElement(saved).jsonObject
            require(o.getValue("owner").jsonPrimitive.content == owner)
            require(o.getValue("payload").jsonPrimitive.content == payload) { "Evidence batch identity conflict" }
            return@commit EvidenceRequest(key, owner, batchId, o.getValue("path").jsonPrimitive.content, o.getValue("body").jsonPrimitive.content, o.getValue("negotiated").jsonPrimitive.boolean)
        }
        val path = if (negotiated) legacyPath.replace("/station/", "/station/grants/v1/evidence/") else legacyPath
        val body = if (!negotiated) payload else {
            val original = Json.parseToJsonElement(payload)
            val compacts = linkedSetOf<String>()
            val associations = linkedMapOf<String, JsonElement>()
            for ((pointer, event) in links) {
                val evidence = db.grantDao().evidence(owner, event) ?: continue
                if (evidence.compact != null) {
                    compacts.add(evidence.compact)
                    // Retired authority can be denied locally in observe mode; retain its original bytes and identity for server classification.
                    val grantId = evidence.grantId ?: runCatching { GrantVerifier(emptyList()).parseStored(evidence.compact).grantId }.getOrNull()
                    if (grantId != null) associations[pointer] = JsonPrimitive(grantId)
                }
            }
            buildJsonObject {
                put("protocol", "offline-grants-v1"); put("batchId", batchId)
                put("payloadDigest", grantDigest(grantEvidenceCanonical(original)))
                put("grants", JsonArray(compacts.map(::JsonPrimitive))); put("eventGrants", JsonObject(associations)); put("payload", original)
            }.toString()
        }
        db.metaDao().put(MetaEntity(key, buildJsonObject {
            put("owner", owner); put("payload", payload); put("path", path); put("body", body); put("negotiated", negotiated)
        }.toString()))
        EvidenceRequest(key, owner, batchId, path, body, negotiated)
    }

    suspend fun receipt(request: EvidenceRequest): String? = db.metaDao().get(request.key + ":receipt")

    /** A duplicate receipt can still be quarantined/rejected. Only a native 2xx result reaches its existing parser. */
    suspend fun nativeResult(request: EvidenceRequest, text: String): String? {
        if (!request.negotiated) return text
        val o = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
        if (o.keys != setOf("protocol", "batchId", "outcome", "reason", "receiptId", "reconciliation")) return null
        if (o["protocol"] != JsonPrimitive("offline-grants-v1") || o["batchId"] != JsonPrimitive(request.batchId)) return null
        val outcome = (o["outcome"] as? JsonPrimitive)?.content ?: return null
        if (outcome !in setOf("accepted", "duplicate", "quarantined")) return null
        if (!(o["reason"] == JsonNull || (o["reason"] as? JsonPrimitive)?.isString == true)) return null
        val id = (o["receiptId"] as? JsonPrimitive)?.content ?: return null
        if (!Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(id)) return null
        val reconciliation = o["reconciliation"] as? JsonObject ?: return null
        if (reconciliation.keys != setOf("status", "statusCode", "result")) return null
        val status = (reconciliation["status"] as? JsonPrimitive)?.content ?: return null
        if (status !in setOf("applied", "rejected", "not_applied")) return null
        val statusCode = reconciliation["statusCode"] as? JsonPrimitive
        if (statusCode?.isString == true) return null
        val code = statusCode?.intOrNull
        if (reconciliation["statusCode"] != JsonNull && (code == null || code !in 100..599)) return null
        val native = reconciliation["result"]
        val applicable = outcome != "quarantined" && status != "not_applied" && code in 200..299 && native != null && native != JsonNull
        val retained = db.recovery.commit {
            require(db.recovery.token().owner.grantOwnerKey() == request.owner)
            val previous = receipt(request)?.let { Json.parseToJsonElement(it).jsonObject }
            // Only the outer accepted -> duplicate marker may change on a final replay.
            if (previous != null && previous.filterKeys { it != "outcome" } != o.filterKeys { it != "outcome" }) return@commit false
            // Keep the complete original request and first final receipt even when the queue cannot be acknowledged.
            if (previous == null) db.metaDao().put(MetaEntity(request.key + ":receipt", text))
            if (!applicable || o["reason"] != JsonNull) db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_DENIED, (o["reason"] as? JsonPrimitive)?.contentOrNull ?: "grant_evidence_$status"))
            val diagnostic = when {
                !applicable || status == "rejected" -> "review"
                o["reason"] != JsonNull -> "observed"
                else -> null
            }
            if (diagnostic != null && db.metaDao().get(diagnosticKey(request.owner)) != "review") {
                db.metaDao().put(MetaEntity(diagnosticKey(request.owner), diagnostic))
            }
            true
        }
        return if (retained && applicable) native.toString() else null
    }
}
