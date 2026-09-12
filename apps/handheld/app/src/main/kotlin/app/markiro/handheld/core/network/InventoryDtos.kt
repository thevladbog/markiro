package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ResolveTaskRequest(val barcode: String)

@Serializable
data class ResolveTaskResponse(val task: InventoryTaskDto, val deviceLineId: String? = null, val requiresDifferentLineConfirmation: Boolean)

/** Optional fields are omitted, not null: the server's strict schema rejects `null` for them. */
@Serializable
data class JoinInventoryRequest(val operatorId: String, val barcode: String? = null, val confirmDifferentLine: Boolean? = null)

@Serializable
data class BundleLimitsDto(val codePageSize: Int, val eventBatchSize: Int, val progressPageSize: Int)

/** Manifest for `check`; repack-only fields are kept opaque and ignored. */
@Serializable
data class InventoryManifestDto(
    val inventoryId: String,
    val inventoryNumber: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val snapshotFixedAt: String,
    val combinedDigest: String,
    val contentDigest: String,
    val codeCount: Int,
    val productId: String,
    val productName: String,
    val productPrintName: String? = null,
    val egaisCode: String? = null,
    val shelfLifeDays: Int? = null,
    val gtin14: String,
    val boxCapacity: Int,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
    val boxLabelTemplate: JsonElement? = null,
    val limits: BundleLimitsDto,
    val sscc: JsonElement? = null,
    val ssccRevokedFrom: JsonElement? = null,
    val ssccRevokedBlocks: JsonElement? = null,
    @kotlinx.serialization.Transient val recoveryGeneration: app.markiro.handheld.core.storage.GenerationToken? = null,
)

@Serializable
data class InventoryBundleCodeDto(
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String? = null,
    val sourceProductionDate: String? = null,
    val parentSscc: String? = null,
    val expected: Boolean,
    val protected: Boolean,
)

@Serializable
data class InventoryBundlePageDto(
    val snapshotId: String,
    val snapshotRevision: Int,
    val snapshotFixedAt: String,
    val combinedDigest: String,
    val contentDigest: String,
    val cursor: String? = null,
    val items: List<InventoryBundleCodeDto>,
    val nextCursor: String? = null,
    val pageDigest: String,
)

@Serializable
data class LeaveInventoryRequest(val pendingEventCount: Int, val openBoxCount: Int)

@Serializable
data class LeaveInventoryResponse(val outcome: String)

@Serializable
data class ClaimWinnerDto(val codeHash: String, val eventId: String, val deviceId: String, val scannedAt: String)

@Serializable
data class ClaimOutcomeDto(val codeHash: String, val status: String, val winner: ClaimWinnerDto)

@Serializable
data class EventOutcomeDto(
    val eventId: String,
    val status: String,
    val reasonCode: String,
    val claimedCount: Int,
    val conflictCount: Int,
    val claims: List<ClaimOutcomeDto> = emptyList(),
)

@Serializable
data class EventBatchResponseDto(
    val inventoryId: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val batchId: String,
    val payloadDigest: String,
    val sequenceCeiling: Long,
    val resultRevision: Long,
    val outcomes: List<EventOutcomeDto>,
)

/** Progress items are a discriminated union on `kind`; repack-only kinds carry fields the check port ignores. */
@Serializable
data class ProgressItemDto(
    val id: String,
    val revision: Long,
    val correctedAt: String,
    val kind: String,
    val codeHash: String? = null,
    val classification: String? = null,
    val observedProductionDate: String? = null,
    val winner: ClaimWinnerDto? = null,
    val boxId: String? = null,
    val resultId: String? = null,
    val ownerDeviceId: String? = null,
    val removedAt: String? = null,
)

@Serializable
data class ProgressPageDto(
    val inventoryId: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val cursor: String? = null,
    val resultRevision: Long,
    val items: List<ProgressItemDto>,
    val nextCursor: String? = null,
)
