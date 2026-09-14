package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

/*
 * Wire shapes for the write-off mode. Field names mirror
 * `apps/api/src/modules/station-writeoffs/dto.ts` and the kiosk box registry;
 * `WriteoffDtosTest` pins them so a server rename fails in CI rather than on a
 * device holding queued documents.
 */

@Serializable
data class WriteoffItemDto(val rawKm: String)

@Serializable
data class WriteoffBoxDto(val sscc: String)

/** Body of `POST /station/writeoffs`. Sent through [SyncTransport] as frozen bytes, not through Retrofit. */
@Serializable
data class WriteoffRequestDto(
    val deviceSeq: Long,
    val operatorId: String,
    val writeoffReasonId: String,
    val items: List<WriteoffItemDto>,
    val boxes: List<WriteoffBoxDto>,
    val createdAt: String,
)

@Serializable
data class WriteoffConflictDto(val rawKm: String, val reason: String)

@Serializable
data class WriteoffBoxConflictDto(val sscc: String, val bottleCount: Int? = null, val reason: String)

@Serializable
data class WriteoffAcceptedBoxDto(val sscc: String, val bottleCount: Int)

/** The kiosk's `CreateOrderResultDto`; a write-off is the same `pickup_orders` row. */
@Serializable
data class WriteoffResultDto(
    val orderNo: String,
    val status: String,
    val itemCount: Int,
    val conflicts: List<WriteoffConflictDto> = emptyList(),
    val boxConflicts: List<WriteoffBoxConflictDto> = emptyList(),
    val acceptedBoxes: List<WriteoffAcceptedBoxDto> = emptyList(),
)

/**
 * What the device keeps about a settled document, in `writeoff_outbox.conflictsJson`.
 * Accepted boxes are not stored: every box the request listed was either accepted
 * or named in `boxConflicts`, so the count follows from the row's own `boxCount`.
 */
@Serializable
data class WriteoffSettlementDto(
    val conflicts: List<WriteoffConflictDto> = emptyList(),
    val boxConflicts: List<WriteoffBoxConflictDto> = emptyList(),
    /** Present only on a refusal: what the server objected to. */
    val error: String? = null,
)

@Serializable
data class WriteoffReasonDto(val id: String, val name: String, val sortOrder: Int)

/** `id` is how the box registry names a product; `gtin14` is how a unit scan resolves one. */
@Serializable
data class WriteoffProductDto(val id: String, val gtin14: String, val name: String)

@Serializable
data class WriteoffOperatorDto(val employeeId: String, val canWriteoff: Boolean)

@Serializable
data class WriteoffBootstrapDto(
    val generatedAt: String,
    val reasons: List<WriteoffReasonDto>,
    val products: List<WriteoffProductDto>,
    val operators: List<WriteoffOperatorDto>,
)

/** One registry change; `remove` carries only `sscc` and `updatedAt`. */
@Serializable
data class BoxRegistryItemDto(
    val kind: String,
    val sscc: String,
    val updatedAt: String,
    val boxId: String? = null,
    val productId: String? = null,
    val bottleCount: Int? = null,
    val contentKeys: List<String>? = null,
)

@Serializable
data class BoxRegistryPageDto(
    val until: String,
    val items: List<BoxRegistryItemDto>,
    val nextCursor: String? = null,
)
