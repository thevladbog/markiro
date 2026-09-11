package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

/**
 * `station-recovery-v1` makes the server return `denied[]` on scan batches, and
 * `validation-dm-duplicate-v1` is what lets this device enter a shift whose
 * validation policy prints a duplicate at all -- without it the server answers
 * `409 STATION_UPDATE_REQUIRED`.
 */
const val HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1,validation-dm-duplicate-v1"
const val REVOKED_CODE = "STATION_CREDENTIAL_REVOKED"
const val UPDATE_REQUIRED_CODE = "STATION_UPDATE_REQUIRED"

@Serializable
data class PairRequest(val code: String)

@Serializable
data class LineDto(val id: String, val name: String)

@Serializable
data class DeviceDto(
    val id: String,
    val name: String,
    val kind: String = "station",
    val tenantId: String,
    val organizationName: String,
    val line: LineDto? = null,
)

@Serializable
data class CredentialDto(val apiKey: String, val serverUrl: String)

@Serializable
data class OperatorDto(
    val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String? = null,
    val active: Boolean,
)

@Serializable
data class PairResponse(val device: DeviceDto, val credential: CredentialDto, val operators: List<OperatorDto>)

@Serializable
data class IdentityResponse(val device: DeviceDto)

@Serializable
data class RosterResponse(val items: List<OperatorDto>)

/** `GET /shifts` item; fields the handheld does not use (images, templates, dates of creation) are ignored. */
@Serializable
data class ShiftDto(
    val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val validationPrint: ValidationPrintDto,
    val productId: String,
    val productName: String? = null,
    val productPrintName: String? = null,
    val lineId: String? = null,
    val lineName: String? = null,
    val counterpartyName: String? = null,
    val plannedQty: Int? = null,
    val plannedDate: String? = null,
    val productionDate: String? = null,
    val boxCapacity: Int? = null,
    val palletBoxCapacity: Int? = null,
    val palletsEnabled: Boolean,
    val openedAt: String? = null,
    val closedAt: String? = null,
    val stationCloseAccess: StationCloseAccessDto? = null,
)

@Serializable
data class ShiftListResponse(val items: List<ShiftDto>)

/** `GET /station/inventory-tasks` item; every field is sent by the server. */
@Serializable
data class InventoryTaskDto(
    val inventoryId: String,
    val inventoryNumber: String,
    val productName: String,
    val productPrintName: String? = null,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
)

@Serializable
data class InventoryTaskListResponse(val items: List<InventoryTaskDto>)

@Serializable
data class ErrorBody(val code: String? = null)
