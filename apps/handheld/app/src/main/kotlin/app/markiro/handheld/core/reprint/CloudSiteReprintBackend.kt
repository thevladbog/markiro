package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.duplicate.productLabelBytesDigest
import kotlinx.serialization.json.*
import java.io.IOException
import java.util.Base64

class CloudSiteReprintBackend(
    private val get: suspend (String) -> JsonObject,
    private val post: suspend (String, String) -> JsonObject,
    private val branding: suspend () -> Unit = {},
) : SiteReprintBackend {
    override suspend fun lookup(raw: String, operatorId: String): SiteReprintLookup {
        branding()
        val response = post("handheld-lookup-v3", buildJsonObject { put("protocol", V3); put("raw", raw); put("operatorId", operatorId) }.toString())
        val result = decodeLookup(raw, response.getValue("result").jsonObject)
        return if (result is SiteReprintLookup.Found) SiteReprintLookup.Found(result.source.copy(
            productId = response.optionalString("productId"),
            groupCode = (response["groupCode"] as? JsonPrimitive)?.intOrNull ?: result.source.groupCode,
        )) else result
    }
    override suspend fun refreshTemplates(): List<SiteReprintTemplate> {
        branding()
        val labels = get("templates")
        require(labels.string("protocol") == V1)
        val units = labels.getValue("templates").jsonArray.mapNotNull { item ->
            val value = item.jsonObject
            if (value["enabled"] != JsonPrimitive(true)) return@mapNotNull null
            val purpose = value.string("purpose")
            if (purpose !in setOf("product_duplicate", "box")) return@mapNotNull null
            val withoutDigest = JsonObject(value.filterKeys { it != "digest" })
            require(reprintDigest(withoutDigest) == value.string("digest"))
            SiteReprintTemplate(value.string("id"), value.string("name"), if (purpose == "product_duplicate") "unit" else "box", value.getValue("spec").toString(), value.toString(), value.string("revision"), value.string("digest"), (value["chzProductGroupCodes"] as? JsonArray)?.map { it.jsonPrimitive.int })
        }
        val pallets = get("handheld-pallet-templates-v3")
        require(pallets.string("protocol") == V3)
        return units + pallets.getValue("templates").jsonArray.mapNotNull { item ->
            val entry = item.jsonObject
            val value = entry.getValue("template").jsonObject
            if (value.string("kind") != "thermal" || value.optionalString("id") == null) return@mapNotNull null
            require(reprintDigest(value.getValue("snapshot")) == value.string("snapshotDigest"))
            SiteReprintTemplate(value.string("id"), value.string("name"), "pallet", value.getValue("snapshot").toString(), value.toString(), value.string("snapshotDigest"), value.string("snapshotDigest"), (entry["groupCodes"] as? JsonArray)?.map { it.jsonPrimitive.int })
        }
    }
    override fun auditPayload(source: SiteReprintSource, input: SiteReprintAuditInput): String {
        if ((source.kind == "pallet" && input.outcome == "sending") || input.outcome == "cancelled") return noOpEnvelope("cloud", input)
        val original = reprintObject(source.sourceJson)
        val bytesDigest = productLabelBytesDigest(Base64.getDecoder().decode(input.bytesBase64))
        if (source.kind == "pallet") {
            val data = original.getValue("data").jsonObject
            val body = buildJsonObject {
                put("version", 3); put("sscc", source.identity); put("sourceRevision", source.revision)
                put("choice", reprintObject(input.template.sourceJson)); put("fields", data.getValue("fields"))
                put("productionDate", data.getValue("productionDate")); put("expiryDate", data.getValue("expiryDate")); put("brandingJson", data.getValue("brandingJson"))
            }
            val revision = reprintDigest(body)
            val rendering = JsonObject(body + ("renderingRevision" to JsonPrimitive(revision)))
            val event = buildJsonObject {
                put("eventId", input.recordId); put("jobId", input.jobId); put("attemptId", input.attemptId)
                put("sscc", source.identity); put("sourceRevision", source.revision); put("renderingRevision", revision)
                put("operatorId", input.operatorId); put("reason", input.reason); put("occurredAt", input.occurredAt)
                put("state", when(input.outcome) { "failed" -> "failed_before_send"; "unknown" -> "delivery_unknown"; else -> input.outcome })
                put("printFormat", input.language); put("bytesDigest", bytesDigest)
            }
            return buildJsonObject {
                put("backend", "cloud"); put("protocol", V3); put("recordId", input.recordId); put("jobId", input.jobId); put("renderingRevision", revision)
                put("renderingBody", buildJsonObject { put("protocol", V3); put("entries", JsonArray(listOf(buildJsonObject { put("jobId", input.jobId); put("operatorId", input.operatorId); put("rendering", rendering) }))) }.toString())
                put("body", buildJsonObject { put("protocol", V3); put("entries", JsonArray(listOf(event))) }.toString())
            }.toString()
        }
        val value = original.getValue("source").jsonObject
        val event = buildJsonObject {
            put("eventId", input.recordId); put("jobId", input.jobId); put("sessionId", input.sessionId); put("attemptId", input.attemptId)
            put("operatorId", input.operatorId); put("sequence", input.sequence); put("occurredAt", input.occurredAt)
            val kind = when(input.outcome) { "prepared" -> if (input.attempt == 1) "prepared" else "reprint_prepared"; "failed" -> "failed_before_send"; "unknown" -> "delivery_unknown"; else -> input.outcome }
            put("kind", kind)
            if (input.outcome == "prepared") {
                put("attemptNo", input.attempt); put("reason", input.reason)
                if (input.attempt == 1) {
                    put("sourceKind", source.kind); put("sourceId", source.subjectId); put("identity", source.identity); put("sourceRevision", source.revision)
                    put("sourceShiftId", value.getValue("sourceShiftId")); put("templateId", input.template.id); put("templateRevision", input.template.revision); put("templateDigest", input.template.digest)
                    put("payloadDigest", value.getValue("payloadDigest")); put("bytesDigest", bytesDigest); put("scanDigest", source.scanDigest.ifEmpty { value.string("payloadDigest") })
                    put("repair", original["repair"] ?: JsonNull); put("language", input.language); put("dpi", input.dpi)
                }
            }
            if (input.outcome == "failed") put("errorCode", when(input.error) { "printer_unconfigured", "printer_changed", "owner_changed" -> input.error; else -> "driver_rejected" })
            if (input.outcome == "unknown") put("errorCode", if(input.error == "interrupted") "interrupted" else "transport_failed")
        }
        return buildJsonObject { put("backend", "cloud"); put("protocol", V1); put("recordId", input.recordId); put("body", buildJsonObject { put("protocol", V1); put("events", JsonArray(listOf(event))) }.toString()) }.toString()
    }
    override suspend fun report(payload: String): SiteReprintReceipt {
        val envelope = reprintObject(payload)
        require(envelope.string("backend") == "cloud")
        if (envelope["localOnly"] == JsonPrimitive(true)) return SiteReprintReceipt.Accepted
        val protocol = envelope.string("protocol")
        if (protocol == V3) {
            val rendering = post("pallet-renderings-v3", envelope.string("renderingBody"))
            if (rendering.string("protocol") != V3) throw IOException("reprint receipt protocol mismatch")
            val receipt = checkedReceipt(rendering, "jobId", envelope.string("jobId"), "renderingRevision" to envelope.string("renderingRevision"))
            if (receipt is SiteReprintReceipt.Rejected) return receipt
            val response = post("pallet-events-v3", envelope.string("body"))
            if (response.string("protocol") != V3) throw IOException("reprint receipt protocol mismatch")
            return checkedReceipt(response, "eventId", envelope.string("recordId"))
        }
        require(protocol == V1)
        val response = post("event-batches", envelope.string("body"))
        if (response.string("protocol") != V1) throw IOException("reprint receipt protocol mismatch")
        val accepted = response.getValue("acceptedEventIds").jsonArray
        val quarantined = response.getValue("quarantined").jsonArray
        val id = envelope.string("recordId")
        if (accepted.size == 1 && accepted.single().jsonPrimitive.content == id && quarantined.isEmpty()) return SiteReprintReceipt.Accepted
        if (accepted.isEmpty() && quarantined.size == 1 && quarantined.single().jsonObject.string("eventId") == id) return SiteReprintReceipt.Rejected(quarantined.single().jsonObject.string("code"))
        throw IOException("reprint receipt mismatch")
    }
    companion object {
        const val V1 = "warehouse-label-reprint-v1"
        const val V3 = "warehouse-unified-reprint-v3"
        fun decodeLookup(raw: String, response: JsonObject): SiteReprintLookup = when (response.string("status")) {
            "not_found" -> SiteReprintLookup.NotFound
            "unavailable" -> SiteReprintLookup.Unavailable(response.string("code"))
            "found" -> try {
                val kind = response.string("kind")
                val value = response.getValue(if (kind == "pallet") "data" else "source").jsonObject
                val revision = value.string("revision")
                require(reprintDigest(JsonObject(value.filterKeys { it != "revision" })) == revision)
                val fields = value.getValue("fields").jsonObject.mapValues { it.value.jsonPrimitive.content }
                val source = SiteReprintSource(kind, if (kind == "pallet") value.string("sscc") else value.string("sourceId"), if (kind == "pallet") value.string("sscc") else value.string("identity"), if (kind == "pallet") fields.getValue("product.printName") else value.string("productName"), fields, response.toString(), groupCode = (value["chzProductGroupCode"] as? JsonPrimitive)?.intOrNull, revision = revision, scanDigest = productLabelBytesDigest(raw.toByteArray(Charsets.UTF_8)), repair = response.optionalString("repair"), unavailableFields = (value["unavailableFields"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty())
                require(kind == "pallet" || value.string("kind") == kind)
                validateSourceIdentity(raw, source)
                SiteReprintLookup.Found(source)
            } catch (_: Exception) { SiteReprintLookup.Unavailable("source_fields_missing") }
            else -> throw IOException("invalid reprint lookup")
        }
    }
}
