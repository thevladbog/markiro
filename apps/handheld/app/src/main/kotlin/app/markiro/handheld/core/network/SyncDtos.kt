package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ScanCodeDto(val codeHash: String, val gtin14: String, val serial: String)

/**
 * One `POST /station/scans` item; `code` is present iff `verdict == "ok"`, and
 * `boxId` only ever accompanies an accepted code — the server rejects the batch
 * otherwise.
 */
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

/**
 * A box closure, scoped with shift and terminal because a device-local box id
 * is not globally unique.
 *
 * `printVerifiedAt` and `printSkippedAt` are always null: print verification is
 * the station's scan-the-label-back reconciliation and this device does not do
 * it. Nothing else in this payload can change after the box closes, which is
 * why acknowledgement here is unconditional — see `SyncEngine`.
 */
@Serializable
data class BoxClosureDto(
    val boxId: String,
    val shiftId: String,
    val terminalId: String?,
    val sscc: String,
    val closedAt: String,
    val operatorId: String?,
    val printVerifiedAt: String? = null,
    val printSkippedAt: String? = null,
)

@Serializable
data class SyncBatchRequest(
    val batchId: String,
    val items: List<ScanItemDto>,
    val boxes: List<BoxClosureDto> = emptyList(),
    /**
     * Product-label events, sent as the stored JSON rather than re-encoded from
     * a class: the server's schema is a strict object per event kind, and a
     * field added or dropped by re-serialising would fail the whole batch.
     */
    val productLabelEvents: List<JsonElement> = emptyList(),
    /**
     * Operator corrections, sent as stored JSON for the same reason the label
     * events are: the server's schema requires every nullable key to be
     * present, and this device's Retrofit converter drops null-valued fields.
     */
    val exceptions: List<JsonElement> = emptyList(),
)

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
