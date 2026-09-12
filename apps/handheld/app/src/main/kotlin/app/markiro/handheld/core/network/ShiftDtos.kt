package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** The duplicate template snapshot; `spec` is the label geometry the device renders from. */
@Serializable
data class DuplicateTemplateDto(val id: String, val name: String, val spec: JsonElement, val digest: String)

/**
 * `mode` is `none` or `duplicate_dm`. Everything else is present only in the
 * second case: the server refuses to snapshot a duplicate policy without a
 * template, so a `duplicate_dm` shift always carries all three.
 */
@Serializable
data class ValidationPrintDto(
    val mode: String,
    val verification: String? = null,
    val snapshot: DuplicateTemplateDto? = null,
    val policyRevision: String? = null,
)

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

/** One label template as the bundle delivers it; the box and pallet slots share this shape. */
@Serializable
data class BundleLabelTemplateDto(val id: String, val name: String, val spec: JsonElement)

/**
 * `GET /shifts/:id/bundle`.
 *
 * The reader sets `ignoreUnknownKeys`, so a field missing HERE is dropped in
 * silence rather than failing: every server field this device needs has to be
 * declared, and `apps/api/src/modules/shifts/dto.ts` is the contract.
 */
@Serializable
data class ShiftBundleDto(
    val shift: ShiftDto,
    val product: BundleProductDto,
    val operators: List<OperatorDto> = emptyList(),
    val boxLabelTemplate: BundleLabelTemplateDto? = null,
    /**
     * The PALLET label's own template (06d). Null exactly when the shift's
     * `palletLabelTemplateId` snapshot is null -- a shift without pallets, or
     * one whose tenant configured no pallet template -- and a device that gets
     * null says so rather than printing an empty label.
     */
    val palletLabelTemplate: BundleLabelTemplateDto? = null,
    val sscc: BundleSsccDto? = null,
    /** `fromSerial` of every block an admin has revoked since it was granted. */
    val ssccRevokedFrom: List<Long> = emptyList(),
    /**
     * This device's PALLET serial block, extension digit 1 (06d). A second,
     * fully independent block from [sscc]; non-null only for a shift with
     * pallets enabled. Without it no pallet can ever be numbered, and every
     * close returns `NoSerials`.
     */
    val palletSscc: BundleSsccDto? = null,
    /** [ssccRevokedFrom] for the pallet stream. Always present, `[]` when empty. */
    val palletSsccRevokedFrom: List<Long> = emptyList(),
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
