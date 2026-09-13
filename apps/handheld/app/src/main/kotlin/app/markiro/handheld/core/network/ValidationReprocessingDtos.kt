package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

const val VALIDATION_REPROCESSING_PROTOCOL = "validation-reprocessing-v1"
@Serializable
data class ValidationHistoryItem(
    val codeHash: String, val kind: String, val shiftId: String, val shiftNumber: String,
    val shiftStatus: String, val scannedAt: String,
)
@Serializable
data class ValidationHistoryPage(
    val protocol: String, val shiftId: String, val productId: String, val snapshot: String,
    val fetchedAt: String, val expiresAt: String, val nextCursor: String?, val complete: Boolean,
    val items: List<ValidationHistoryItem>,
)
@Serializable
data class ValidationOccurrenceIdentity(val shiftId: String, val codeHash: String, val scannedAt: String)
@Serializable
data class ValidationOccurrenceReceipt(val shiftId: String, val codeHash: String, val scannedAt: String, val outcome: String, val ownership: String? = null) {
    init { require(ownership == null || (ownership == "released" && outcome == "first_accepted")) }
}
@Serializable
data class ValidationOccurrenceStatusRequest(val occurrences: List<ValidationOccurrenceIdentity>)
@Serializable
data class ValidationOccurrenceStatusResponse(val protocol: String, val occurrences: List<ValidationOccurrenceReceipt>)
