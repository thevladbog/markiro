package app.markiro.handheld.core.network.host

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class HelloDto(
    val product: String,
    val protocol: Int,
    val minProtocol: Int,
    val hostId: String,
    val version: String? = null,
    val time: String? = null,
    val initialized: Boolean = true,
    val restoreEpoch: String? = null,
    val datasetEpoch: String? = null,
)

@Serializable
data class PairedDto(val deviceId: String, val deviceKey: String, val hostId: String)

@Serializable
data class DeviceInfoDto(val id: String, val kind: String, val name: String, val lineId: String? = null, val pairedAt: String? = null)

@Serializable
data class ChangeItemDto(val entity: String, val id: String, val rev: Long, val deleted: Boolean, val data: JsonObject? = null)

@Serializable
data class ChangesDto(val hostId: String, val rev: Long, val hasMore: Boolean, val items: List<ChangeItemDto>)

@Serializable
data class SsccBlockDto(val id: String, val issuerPrefix: String, val extension: Int, val fromSerial: Long, val toSerial: Long)

/** A block this device holds, told to a host restored from a copy (`POST /v1/device/sscc/blocks/known`). */
data class KnownBlock(val id: String, val issuerPrefix: String, val extension: Int, val fromSerial: Long, val toSerial: Long)

@Serializable
data class KnownBlockResultDto(val id: String, val outcome: String, val code: String? = null)

@Serializable
data class KnownBlocksResponseDto(val results: List<KnownBlockResultDto>)

@Serializable
data class ShiftSnapshotDto(
    val product: JsonObject,
    val boxTemplate: JsonObject,
    val issuerPrefix: String,
    val counterpartyName: String? = null,
    val palletTemplate: JsonObject? = null,
    val organization: JsonObject? = null,
)

/** A device's part in a shift (host protocol 7, `ShiftParticipant`): the strings are the host's, read as they come (`active|left|closed`). */
@Serializable
data class ShiftParticipantDto(
    val deviceId: String,
    val deviceKind: String,
    val deviceName: String,
    val state: String,
    val firstEnteredAt: String? = null,
    val joinedAt: String? = null,
    /** The host revision of the write that took this slot: the token the leave echoes (`ShiftLeave`); absent from an older host. */
    val joinedRev: Long? = null,
    val leftAt: String? = null,
    val closedAt: String? = null,
    val closedBy: String? = null,
    val closedActualQty: Int? = null,
    val closedReasonCode: String? = null,
    val lateDataAt: String? = null,
    val lastSeenAt: String? = null,
)

/** One device's accepted units, closed boxes and closed pallets in a shift, counted by the host from the facts it holds. */
@Serializable
data class DeviceTotalsDto(val deviceId: String, val accepted: Long, val boxesClosed: Int = 0, val pallets: Int = 0)

/** The shift-wide totals and the host's clock at the moment it counted them (`asOf`, a host instant: whole seconds, `Z`). */
@Serializable
data class DeviceShiftTotalsDto(val accepted: Long, val boxesClosed: Int = 0, val pallets: Int = 0, val asOf: String)

@Serializable
data class DeviceShiftDto(
    val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val palletsEnabled: Boolean = false,
    val lineId: String,
    val productId: String,
    val productName: String,
    val productGtin14: String,
    val counterpartyName: String? = null,
    val productionDate: String,
    val plannedDate: String? = null,
    val plannedQty: Int? = null,
    val boxCapacity: Int,
    val palletBoxCapacity: Int? = null,
    val ownerDeviceId: String? = null,
    val openedAt: String? = null,
    val closedAt: String? = null,
    val snapshot: ShiftSnapshotDto? = null,
    /**
     * Protocol 7, open or closed shifts only; every one is absent from an older host and from a planned shift. In the list `totals` and `byDevice`
     * come for an active shift only; the answer of an entry or a leave carries them for a closed shift too.
     */
    val maxStations: Int? = null,
    val participants: List<ShiftParticipantDto>? = null,
    /** This device's own state; absent when it never entered. */
    val myState: String? = null,
    val totals: DeviceShiftTotalsDto? = null,
    val byDevice: List<DeviceTotalsDto>? = null,
)

@Serializable
data class DeviceShiftsDto(val shifts: List<DeviceShiftDto>)

@Serializable
data class FactReceiptDto(val id: String? = null, val outcome: String, val code: String? = null, val details: JsonObject? = null)

@Serializable
data class FactReceiptsDto(val receipts: List<FactReceiptDto>)

@Serializable
data class OrgPrintDto(val name: String, val inn: String? = null, val issuerPrefix: String, val logo: JsonElement? = null)

@Serializable
data class ErrorEnvelopeDto(val error: ErrorDto)

@Serializable
data class ErrorDto(val code: String, val message: String? = null, val details: JsonObject? = null)
