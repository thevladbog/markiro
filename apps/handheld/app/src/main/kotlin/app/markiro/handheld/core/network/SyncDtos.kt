package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

@Serializable
data class ScanCodeDto(val codeHash: String, val gtin14: String, val serial: String)

/** One `POST /station/scans` item; `code` present iff `verdict == "ok"`, `boxId` always null here. */
@Serializable
data class ScanItemDto(
    val shiftId: String,
    val terminalId: String?,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val code: ScanCodeDto?,
    val operatorId: String?,
    val boxId: String? = null,
)

@Serializable
data class SyncBatchRequest(val batchId: String, val items: List<ScanItemDto>)

@Serializable
data class BatchConflictDto(val codeHash: String, val winningTerminalId: String? = null, val winningScannedAt: String? = null)

@Serializable
data class ShiftCloseRequest(
    val eventId: String,
    val shiftId: String,
    val operatorId: String?,
    val plannedQtySnapshot: Int?,
    val actualQty: Int,
    val closedBoxCount: Int,
    val reasonCode: String?,
    val closedAt: String,
)

@Serializable
data class ShiftCloseResponse(val outcome: String, val conflictCode: String? = null)

@Serializable
data class ConflictStatusRequest(val codeHashes: List<String>)

@Serializable
data class ConflictStatusResponse(val reviewedCodeHashes: List<String> = emptyList())
