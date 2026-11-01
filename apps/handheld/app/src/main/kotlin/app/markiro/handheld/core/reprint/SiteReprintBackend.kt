package app.markiro.handheld.core.reprint

import kotlinx.serialization.Serializable

/** Source belongs to its server/site; sourceJson retains the exact backend-specific snapshot. */
@Serializable
data class SiteReprintSource(
    val kind: String,
    val subjectId: String,
    val identity: String,
    val productName: String,
    val fields: Map<String, String>,
    val sourceJson: String,
    val productId: String? = null,
    val groupCode: Int? = null,
    val revision: String = "",
    val defaultTemplateId: String? = null,
    val unavailableFields: List<String> = emptyList(),
    val scanDigest: String = "",
    val repair: String? = null,
)

@Serializable
data class SiteReprintTemplate(
    val id: String,
    val name: String,
    /** unit, box, pallet */
    val kind: String,
    val specJson: String,
    val sourceJson: String,
    val revision: String = "",
    val digest: String = "",
    val groupCodes: List<Int>? = null,
    val productId: String? = null,
)

sealed interface SiteReprintLookup {
    data class Found(val source: SiteReprintSource) : SiteReprintLookup
    data object NotFound : SiteReprintLookup
    data class Unavailable(val code: String) : SiteReprintLookup
}

/** Immutable inputs to a backend audit envelope; ids/time/bytes must never be regenerated on retry. */
data class SiteReprintAuditInput(
    val recordId: String,
    val sessionId: String,
    val jobId: String,
    val attemptId: String,
    val attempt: Int,
    val reason: String,
    /** prepared, sent, failed, unknown, verified, cancelled */
    val outcome: String,
    val error: String?,
    val template: SiteReprintTemplate,
    val printerId: String,
    val language: String,
    val dpi: Int,
    val bytesBase64: String,
    val operatorId: String,
    val occurredAt: String,
    val sequence: Long,
)

sealed interface SiteReprintReceipt {
    data object Accepted : SiteReprintReceipt
    data class Rejected(val code: String) : SiteReprintReceipt
}

interface SiteReprintBackend {
    suspend fun lookup(raw: String, operatorId: String): SiteReprintLookup
    suspend fun refreshTemplates(): List<SiteReprintTemplate>
    fun auditPayload(source: SiteReprintSource, input: SiteReprintAuditInput): String
    /** Throws on transient failure; only an exact receipt for this frozen envelope may acknowledge it. */
    suspend fun report(payload: String): SiteReprintReceipt
}
