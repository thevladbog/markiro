package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

@Serializable
data class ValidationPrintDto(val mode: String)

@Serializable
data class StationCloseAccessDto(val kind: String, val ownerDeviceId: String? = null)

@Serializable
data class BundleProductDto(val id: String, val gtin14: String, val name: String, val printName: String? = null)

/** `GET /shifts/:id/bundle`; label templates and SSCC blocks are ignored in this slice. */
@Serializable
data class ShiftBundleDto(val shift: ShiftDto, val product: BundleProductDto, val operators: List<OperatorDto> = emptyList())

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
