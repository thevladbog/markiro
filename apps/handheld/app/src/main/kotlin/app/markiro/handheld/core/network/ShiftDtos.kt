package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ValidationPrintDto(val mode: String)

@Serializable
data class StationCloseAccessDto(val kind: String, val ownerDeviceId: String? = null)

@Serializable
data class BundleProductDto(
    val id: String,
    val gtin14: String,
    val name: String,
    val printName: String? = null,
    val shelfLifeDays: Int? = null,
    val egaisCode: String? = null,
)

/**
 * The box serial block this device may print from. `fromSerial`/`toSerial` are
 * always the block's ORIGINAL bounds, even on a repeat fetch of one already
 * held, and `consumedThroughSerial` is the server's own cursor into it.
 */
@Serializable
data class BundleSsccDto(
    val issuerPrefix: String,
    val extensionDigit: Int,
    val fromSerial: Long,
    val toSerial: Long,
    val consumedThroughSerial: Long? = null,
)

@Serializable
data class BundleBoxTemplateDto(val id: String, val name: String, val spec: JsonElement)

/** `GET /shifts/:id/bundle`. */
@Serializable
data class ShiftBundleDto(
    val shift: ShiftDto,
    val product: BundleProductDto,
    val operators: List<OperatorDto> = emptyList(),
    val boxLabelTemplate: BundleBoxTemplateDto? = null,
    val sscc: BundleSsccDto? = null,
    /** `fromSerial` of every block an admin has revoked since it was granted. */
    val ssccRevokedFrom: List<Long> = emptyList(),
)

@Serializable
data class ShiftOutputDto(
    val mode: String,
    val acceptedUnits: Int? = null,
    val closedBoxes: Int? = null,
    val containedUnits: Int? = null,
)

@Serializable
data class ParticipantDto(
    val employeeId: String,
    val fullName: String,
    val role: String? = null,
    val firstActivityAt: String,
    val lastActivityAt: String,
    val acceptedScans: Int,
    val closedBoxes: Int,
)

@Serializable
data class UnattributedDto(val eventCount: Int, val acceptedScans: Int, val closedBoxes: Int)

@Serializable
data class ShiftSummaryDto(
    val generatedAt: String,
    val output: ShiftOutputDto,
    val participants: List<ParticipantDto> = emptyList(),
    val unattributed: UnattributedDto? = null,
)

@Serializable
data class LineListResponse(val items: List<LineDto>)
