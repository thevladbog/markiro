package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.box.*
import app.markiro.handheld.core.duplicate.productLabelBytesDigest
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.label.LabelField
import kotlinx.serialization.json.*
import java.io.IOException

/** Pinned Host transport is supplied by the module; no cloud DTOs cross this boundary. */
class HostSiteReprintBackend(
    private val call: suspend (String, String) -> JsonObject,
    private val catalog: suspend () -> List<SiteReprintTemplate>,
    private val branding: suspend () -> Unit = {},
) : SiteReprintBackend {
    override suspend fun lookup(raw: String, operatorId: String): SiteReprintLookup {
        val sscc = siteReprintSscc(raw)
        val body = buildJsonObject {
            if (sscc != null) put("sscc", sscc) else put("codeHash", KmCodec.hash(KmCodec.canonicalize(raw)))
        }
        branding()
        return decodeLookup(raw, call("lookup", body.toString()))
    }
    override suspend fun refreshTemplates(): List<SiteReprintTemplate> { branding(); return catalog() }
    override fun auditPayload(source: SiteReprintSource, input: SiteReprintAuditInput): String {
        // Host v1 records describe completed outcomes. Preparation/sending remain durable in Room.
        if (input.outcome in setOf("prepared", "sending")) return noOpEnvelope("host", input)
        val record = buildJsonObject {
            put("id", input.recordId); put("sessionId", input.sessionId); put("jobId", input.jobId)
            put("attempt", input.attempt); put("subjectKind", source.kind); put("subjectId", source.subjectId)
            put("identity", source.identity); put("reasonCode", input.reason); put("repair", source.repair?.let(::JsonPrimitive) ?: JsonNull)
            put("templateId", input.template.id.removePrefix("host:")); put("templateRev", input.template.revision.toLongOrNull() ?: 0)
            put("outcome", input.outcome); put("errorCode", if (input.outcome in setOf("failed", "unknown")) JsonPrimitive(input.error?.takeIf { it.matches(Regex("[a-z_]{1,64}")) } ?: "transport_failed") else JsonNull)
            put("operatorId", input.operatorId); put("occurredAt", input.occurredAt)
        }
        return buildJsonObject { put("backend", "host"); put("recordId", input.recordId); put("body", buildJsonObject { put("records", JsonArray(listOf(record))) }.toString()) }.toString()
    }
    override suspend fun report(payload: String): SiteReprintReceipt {
        val envelope = reprintObject(payload)
        require(envelope.string("backend") == "host")
        if (envelope["localOnly"] == JsonPrimitive(true)) return SiteReprintReceipt.Accepted
        val response = call("reprints", envelope.string("body"))
        val rows = response["receipts"]?.jsonArray ?: throw IOException("reprint receipt missing")
        val row = rows.singleOrNull()?.jsonObject ?: throw IOException("reprint receipt mismatch")
        if (row.optionalString("id") != envelope.string("recordId")) throw IOException("reprint receipt mismatch")
        return when (row.string("outcome")) {
            "accepted" -> if (row.optionalString("code") == null) SiteReprintReceipt.Accepted else throw IOException("reprint receipt invalid")
            "rejected" -> SiteReprintReceipt.Rejected(row.string("code"))
            else -> throw IOException("reprint receipt invalid")
        }
    }
    companion object {
        fun decodeLookup(raw: String, response: JsonObject): SiteReprintLookup = when (response.string("status")) {
            "not_found" -> SiteReprintLookup.NotFound
            "unavailable" -> SiteReprintLookup.Unavailable(response.string("reason"))
            "found" -> try {
                val value = response.getValue("source").jsonObject
                val product = value.getValue("product").jsonObject
                val kind = value.string("kind")
                val sscc = value.optionalString("sscc").orEmpty()
                val base = BoxLabelInput(
                    sscc, value.number("itemCount"), product.string("name"), product.optionalString("printName"),
                    product.string("gtin14"), product.optionalString("egaisCode"),
                    (product["shelfLifeDays"] as? JsonPrimitive)?.intOrNull, value.optionalString("operatorName"),
                    value.optionalString("counterpartyName"), value.string("at"), value.string("productionDate"),
                    value.string("shiftNumber"), value.optionalString("lotNumber"),
                )
                val fields = if (kind == "pallet") palletLabelFields(
                    PalletLabelInput(
                        sscc, value.number("boxCount"), base.itemCount, base.productName, base.productPrintName,
                        base.gtin14, base.egaisCode, base.shelfLifeDays, base.operatorName, base.counterpartyName,
                        base.closedAt, base.productionDate, base.shiftNumber, base.lotNumber,
                    ),
                ) else boxLabelFields(base)
                val wire = fields.mapKeys { it.key.wire }.toMutableMap()
                wire.putIfAbsent(LabelField.LOT_NUMBER.wire, "")
                if (kind == "unit") { wire[LabelField.KM_CODE.wire] = value.string("canonical"); wire[LabelField.SSCC.wire] = "" }
                val source = SiteReprintSource(kind, value.string("subjectId"), value.string("identity"), product.string("name"), wire, value.toString(), product.string("id"), (product["chzProductGroupCode"] as? JsonPrimitive)?.intOrNull, reprintDigest(value), scanDigest = productLabelBytesDigest(raw.toByteArray(Charsets.UTF_8)), repair = if (Regex("^(?:\\]C[01])?!1").containsMatchIn(raw.trim())) "legacy_tspl_fnc1_literal" else null)
                validateSourceIdentity(raw, source)
                SiteReprintLookup.Found(source)
            } catch (_: Exception) { SiteReprintLookup.Unavailable("source_fields_missing") }
            else -> throw IOException("invalid reprint lookup")
        }
    }
}
