package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

const val HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1"
const val REVOKED_CODE = "STATION_CREDENTIAL_REVOKED"

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

@Serializable
data class ShiftDto(val id: String, val number: String, val status: String, val lineId: String? = null)

@Serializable
data class ShiftListResponse(val items: List<ShiftDto>)

@Serializable
data class InventoryTaskDto(val inventoryId: String, val inventoryNumber: String, val productName: String)

@Serializable
data class InventoryTaskListResponse(val items: List<InventoryTaskDto>)

@Serializable
data class ErrorBody(val code: String? = null)
